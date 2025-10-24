const express = require('express');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const csrf = require('csurf');
const path = require('path');
const admin = require('firebase-admin');
const TelegramBot = require('node-telegram-bot-api');
const multer = require('multer');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware أساسية
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// إنشاء مجلد التحميلات إذا لم يكن موجوداً
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// 🔐 إعداد CSRF
const csrfProtection = csrf({
  cookie: {
    key: '_csrf',        // لتخزين الـ secret الداخلي
    httpOnly: true,
    secure: false,       // اجعلها true في production مع HTTPS
    sameSite: 'lax'
  }
});

// 🔹 إعداد multer لرفع الملفات
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/')
  },
  filename: function (req, file, cb) {
    // إنشاء اسم فريد للملف
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'screenshot-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  // قبول الصور فقط
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('يجب رفع صورة فقط!'), false);
  }
};

const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB حد أقصى
  }
});

// 🔹 مسار لجلب الـ CSRF Token
app.get('/api/csrf-token', csrfProtection, (req, res) => {
  const token = req.csrfToken();
  // إرسال التوكن في الكوكي حتى يقدر الـ frontend يقرأه
  res.cookie('XSRF-TOKEN', token, {
    httpOnly: false,
    secure: false,
    sameSite: 'lax'
  });
  res.json({ csrfToken: token });
});

// Firebase Admin initialization
let firebaseInitialized = false;
if (process.env.FIREBASE_CONFIG) {
  try {
    const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig),
      databaseURL: `https://${firebaseConfig.project_id}.firebaseio.com`
    });
    firebaseInitialized = true;
    console.log('Firebase initialized successfully');
  } catch (error) {
    console.error('Firebase initialization error:', error);
  }
}

// Telegram Bot
let telegramBot = null;
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
}

// بيانات الاشتراكات
const subscriptions = [
  { id: 1, name: 'نيتفلكس', price: 260, duration: 'شهر' },
  { id: 2, name: 'واتش ات', price: 35, duration: 'شهر' },
  { id: 3, name: 'شاهد', price: 25, duration: 'شهر' },
  { id: 4, name: 'يانجو بلاي', price: 30, duration: 'شهر' }
];

// Middleware للتحقق من JWT (للادمن فقط)
const authenticateToken = (req, res, next) => {
  const token = req.cookies.token;
  
  if (!token) {
    return res.redirect('/login.html');
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      res.clearCookie('token');
      return res.redirect('/login.html');
    }
    req.user = user;
    next();
  });
};

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login.html', csrfProtection, (req, res) => {
  res.cookie('XSRF-TOKEN', req.csrfToken());
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard.html', authenticateToken, csrfProtection, (req, res) => {
  res.cookie('XSRF-TOKEN', req.csrfToken());
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// API Routes

// ✅ تسجيل الدخول مع حماية CSRF
app.post('/api/admin/login', csrfProtection, (req, res) => {
  const { username, password } = req.body;

  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '2h' });
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false
    });
    return res.json({ success: true, message: 'تم تسجيل الدخول بنجاح' });
  }

  res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
});

// طلب اشتراك من العميل (بدون تسجيل دخول) مع رفع الملف
app.post('/api/subscription-order', upload.single('transferScreenshot'), async (req, res) => {
  try {
    const { subscriptionId, accountName, email, phone, transferNumber } = req.body;
    
    const subscription = subscriptions.find(sub => sub.id === parseInt(subscriptionId));
    
    if (!subscription) {
      // حذف الملف إذا كان تم رفعه
      if (req.file) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({ success: false, message: 'الاشتراك غير موجود' });
    }

    // التحقق من وجود الملف
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'يجب رفع صورة التحويل' });
    }
    
    const screenshotPath = '/uploads/' + req.file.filename;
    
    // حفظ الطلب في Firestore
    let orderId = null;
    if (firebaseInitialized) {
      const db = admin.firestore();
      const orderRef = await db.collection('orders').add({
        subscriptionId,
        subscriptionName: subscription.name,
        subscriptionPrice: subscription.price,
        accountName,
        email,
        phone,
        transferNumber,
        transferScreenshot: screenshotPath,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'pending',
        type: 'customer_order'
      });
      orderId = orderRef.id;
    }
    
    // إرسال إشعار على التيليجرام
    if (telegramBot) {
      const message = `
🎯 طلب اشتراك جديد من العميل
━━━━━━━━━━━━━━━━━━━━
📺 المنصة: ${subscription.name}
💰 السعر: ${subscription.price} جنيه
👤 اسم الحساب: ${accountName}
📧 البريد الإلكتروني: ${email}
📞 رقم الهاتف: ${phone}
🔢 رقم التحويل: ${transferNumber}
🖼️ صورة التحويل: ${req.protocol}://${req.get('host')}${screenshotPath}
🆔 رقم الطلب: ${orderId || 'N/A'}
⏰ الوقت: ${new Date().toLocaleString('ar-EG')}
      `;
      
      try {
        await telegramBot.sendMessage(process.env.TELEGRAM_CHAT_ID, message);
      } catch (error) {
        console.error('Telegram send message error:', error);
      }
    }
    
    res.json({ 
      success: true, 
      message: 'تم استلام طلبك بنجاح وسيتم مراجعته قريباً',
      orderId: orderId
    });
    
  } catch (error) {
    console.error('Order processing error:', error);
    // حذف الملف إذا كان تم رفعه
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء معالجة الطلب' });
  }
});

// جلب الطلبات للادمن
app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    if (!firebaseInitialized) {
      return res.json([]);
    }
    
    const db = admin.firestore();
    const ordersSnapshot = await db.collection('orders')
      .orderBy('createdAt', 'desc')
      .get();
    
    const orders = [];
    ordersSnapshot.forEach(doc => {
      const data = doc.data();
        orders.push({
          id: doc.id,
        ...data,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
        updatedAt: data.updatedAt ? data.updatedAt.toDate().toISOString() : null
      });
    });
    
    res.json(orders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// جلب صورة التحويل
app.get('/api/screenshot/:filename', authenticateToken, (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);
  
  // التحقق من أن الملف موجود وآمن
  if (fs.existsSync(filePath) && filename.startsWith('screenshot-')) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'الصورة غير موجودة' });
  }
});

// تحديث حالة الطلب
app.put('/api/orders/:id', authenticateToken, csrfProtection, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    if (!firebaseInitialized) {
      return res.status(500).json({ error: 'Firebase not initialized' });
    }
    
    const db = admin.firestore();
    await db.collection('orders').doc(id).update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ success: true, message: 'تم تحديث حالة الطلب' });
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// إرسال اقتراح من العميل
app.post('/api/suggestion', async (req, res) => {
  try {
    const { name, email, message } = req.body;
    
    if (!message) {
      return res.status(400).json({ success: false, message: 'يرجى كتابة الاقتراح أو الملاحظة' });
    }
    
    // حفظ الاقتراح في Firestore
    let suggestionId = null;
    if (firebaseInitialized) {
      const db = admin.firestore();
      const suggestionRef = await db.collection('suggestions').add({
        name: name || 'غير مذكور',
        email: email || 'غير مذكور',
        message,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        type: 'suggestion'
      });
      suggestionId = suggestionRef.id;
    }
    
    // إرسال إشعار على التيليجرام
    if (telegramBot) {
      const telegramMessage = `
💡 اقتراح جديد من العميل
━━━━━━━━━━━━━━━━━━━━
👤 الاسم: ${name || 'غير مذكور'}
📧 البريد الإلكتروني: ${email || 'غير مذكور'}
💬 الاقتراح:
${message}
🆔 رقم الاقتراح: ${suggestionId || 'N/A'}
⏰ الوقت: ${new Date().toLocaleString('ar-EG')}
      `;
      
      try {
        await telegramBot.sendMessage(process.env.TELEGRAM_CHAT_ID, telegramMessage);
      } catch (error) {
        console.error('Telegram send suggestion error:', error);
      }
    }
    
    res.json({ 
      success: true, 
      message: 'شكراً لك! تم استلام اقتراحك بنجاح وسيتم دراسته',
      suggestionId: suggestionId
    });
    
  } catch (error) {
    console.error('Suggestion processing error:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء معالجة الاقتراح' });
  }
});

// إرسال استفسار من العميل
app.post('/api/inquiry', async (req, res) => {
  try {
    const { name, email, phone, subject, message } = req.body;
    
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ success: false, message: 'يرجى ملء جميع الحقول المطلوبة' });
    }
    
    // حفظ الاستفسار في Firestore
    let inquiryId = null;
    if (firebaseInitialized) {
      const db = admin.firestore();
      const inquiryRef = await db.collection('inquiries').add({
        name,
        email,
        phone: phone || 'غير مذكور',
        subject,
        message,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        type: 'inquiry',
        status: 'new'
      });
      inquiryId = inquiryRef.id;
    }
    
    // إرسال إشعار على التيليجرام
    if (telegramBot) {
      const telegramMessage = `
❓ استفسار جديد من العميل
━━━━━━━━━━━━━━━━━━━━
👤 الاسم: ${name}
📧 البريد الإلكتروني: ${email}
📞 رقم الهاتف: ${phone || 'غير مذكور'}
📋 الموضوع: ${subject}
💬 تفاصيل الاستفسار:
${message}
🆔 رقم الاستفسار: ${inquiryId || 'N/A'}
⏰ الوقت: ${new Date().toLocaleString('ar-EG')}
      `;
      
      try {
        await telegramBot.sendMessage(process.env.TELEGRAM_CHAT_ID, telegramMessage);
      } catch (error) {
        console.error('Telegram send inquiry error:', error);
      }
    }
    
    res.json({ 
      success: true, 
      message: 'شكراً لك! تم استلام استفسارك بنجاح وسيتم الرد عليك قريباً',
      inquiryId: inquiryId
    });
    
  } catch (error) {
    console.error('Inquiry processing error:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء معالجة الاستفسار' });
  }
});

// جلب الاقتراحات للادمن
app.get('/api/suggestions', authenticateToken, async (req, res) => {
  try {
    if (!firebaseInitialized) {
      return res.json([]);
    }
    
    const db = admin.firestore();
    const suggestionsSnapshot = await db.collection('suggestions')
      .orderBy('createdAt', 'desc')
      .get();
    
    const suggestions = [];
    suggestionsSnapshot.forEach(doc => {
      const data = doc.data();
      suggestions.push({
        id: doc.id,
        ...data,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
      });
    });
    
    res.json(suggestions);
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// جلب الاستفسارات للادمن
app.get('/api/inquiries', authenticateToken, async (req, res) => {
  try {
    if (!firebaseInitialized) {
      return res.json([]);
    }
    
    const db = admin.firestore();
    const inquiriesSnapshot = await db.collection('inquiries')
      .orderBy('createdAt', 'desc')
      .get();
    
    const inquiries = [];
    inquiriesSnapshot.forEach(doc => {
      const data = doc.data();
      inquiries.push({
        id: doc.id,
        ...data,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
      });
    });
    
    res.json(inquiries);
  } catch (error) {
    console.error('Error fetching inquiries:', error);
    res.status(500).json({ error: 'Failed to fetch inquiries' });
  }
});

// تحديث حالة الاستفسار
app.put('/api/inquiries/:id', authenticateToken, csrfProtection, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    if (!firebaseInitialized) {
      return res.status(500).json({ error: 'Firebase not initialized' });
    }
    
    const db = admin.firestore();
    await db.collection('inquiries').doc(id).update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ success: true, message: 'تم تحديث حالة الاستفسار' });
  } catch (error) {
    console.error('Error updating inquiry:', error);
    res.status(500).json({ error: 'Failed to update inquiry' });
  }
});

// 🔹 تسجيل الخروج
app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'تم تسجيل الخروج بنجاح' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
