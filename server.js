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

// ✅ ملاحظة أمنية: ما بنعملش static لـ uploads عشان تبقى للأدمن فقط
// app.use('/uploads', express.static('uploads'));

// إنشاء مجلد التحميلات إذا لم يكن موجوداً
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// 🔐 إعداد CSRF
const csrfProtection = csrf({
  cookie: {
    key: '_csrf',
    httpOnly: true,
    secure: false,   // خليها true في production مع HTTPS
    sameSite: 'lax'
  }
});

// 🔹 إعداد multer لرفع الملفات
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'screenshot-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) cb(null, true);
  else cb(new Error('يجب رفع صورة فقط!'), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// 🔹 مسار لجلب الـ CSRF Token
app.get('/api/csrf-token', csrfProtection, (req, res) => {
  const token = req.csrfToken();
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

// بيانات الاشتراكات الأساسية (دي بتفيد لو العميل مبعتش باقة)
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
    return res.status(401).json({ error: 'Unauthorized' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      res.clearCookie('token');
      return res.status(401).json({ error: 'Unauthorized' });
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
  res.cookie('XSRF-TOKEN', req.csrfToken(), { httpOnly: false, sameSite: 'lax', secure: false });
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard.html', (req, res, next) => {
  // HTML نفسه لازم يتفتح لو التوكن موجود، وإلا يحول لوجين
  const token = req.cookies.token;
  if (!token) return res.redirect('/login.html');

  jwt.verify(token, process.env.JWT_SECRET, (err) => {
    if (err) {
      res.clearCookie('token');
      return res.redirect('/login.html');
    }
    next();
  });
}, csrfProtection, (req, res) => {
  res.cookie('XSRF-TOKEN', req.csrfToken(), { httpOnly: false, sameSite: 'lax', secure: false });
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

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

// ✅ طلب اشتراك من العميل (بدون تسجيل دخول) + رفع صورة
app.post('/api/subscription-order', upload.single('transferScreenshot'), async (req, res) => {
  try {
    const {
      subscriptionId,
      accountName,
      email,
      phone,
      transferNumber,

      // ✅ حقول الباقة الجديدة
      planId,
      planName,
      planDuration, // monthly | yearly
      planPrice
    } = req.body;

    const subscription = subscriptions.find(sub => sub.id === parseInt(subscriptionId));

    if (!subscription) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, message: 'الاشتراك غير موجود' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'يجب رفع صورة التحويل' });
    }

    const screenshotPath = '/uploads/' + req.file.filename; // ✅ نخزنها كمسار منطقي

    // ✅ Normalize للمدة
    const normalizedDuration =
      planDuration === 'monthly' ? 'شهري' :
      planDuration === 'yearly'  ? 'سنوي' : null;

    const parsedPlanPrice = planPrice ? Number(planPrice) : null;
    const finalPrice = Number.isFinite(parsedPlanPrice) ? parsedPlanPrice : subscription.price;
    const finalPlanName = planName || subscription.name;

    let orderId = null;

    // حفظ الطلب في Firestore
    if (firebaseInitialized) {
      const db = admin.firestore();

      const orderRef = await db.collection('orders').add({
        subscriptionId: String(subscriptionId),
        subscriptionName: subscription.name,

        // ✅ بيانات الباقة
        planId: planId || null,
        planName: finalPlanName,
        planDuration: normalizedDuration,  // "شهري" | "سنوي" | null
        planPrice: finalPrice,

        // ✅ للتوافق لو كنت بتعتمد على القديم
        subscriptionPrice: finalPrice,

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

    // إرسال إشعار تيليجرام
    if (telegramBot) {
      const secureScreenshotUrl =
        `${req.protocol}://${req.get('host')}/api/screenshot/${encodeURIComponent(req.file.filename)}`;

      const message = `
🎯 طلب اشتراك جديد من العميل
━━━━━━━━━━━━━━━━━━━━
📺 المنصة: ${subscription.name}
📦 الباقة: ${finalPlanName}
🗓️ المدة: ${normalizedDuration || 'غير محدد'}
💰 السعر: ${finalPrice} جنيه
👤 اسم الحساب: ${accountName}
📧 البريد الإلكتروني: ${email}
📞 رقم الهاتف: ${phone}
🔢 رقم التحويل: ${transferNumber}
🖼️ صورة التحويل: ${secureScreenshotUrl}
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
      orderId
    });

  } catch (error) {
    console.error('Order processing error:', error);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء معالجة الطلب' });
  }
});

// ✅ جلب الطلبات للادمن
app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    if (!firebaseInitialized) return res.json([]);

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

// ✅ عرض صورة التحويل (للأدمن فقط)
app.get('/api/screenshot/:filename', authenticateToken, (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);

  if (fs.existsSync(filePath) && filename.startsWith('screenshot-')) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'الصورة غير موجودة' });
  }
});

// ✅ تحديث حالة الطلب
app.put('/api/orders/:id', authenticateToken, csrfProtection, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!firebaseInitialized) {
      return res.status(500).json({ error: 'Firebase not initialized' });
    }

    const allowed = ['pending', 'completed', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, error: 'Status not allowed' });
    }

    const db = admin.firestore();
    await db.collection('orders').doc(id).update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, message: 'تم تحديث حالة الطلب' });
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ success: false, error: 'Failed to update order' });
  }
});

// ✅ تسجيل الخروج (CSRF اختياري هنا بس خلّيناه موجود عندك في الفرونت)
app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'تم تسجيل الخروج بنجاح' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
