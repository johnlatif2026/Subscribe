const express = require('express');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const csrf = require('csurf');
const path = require('path');
const admin = require('firebase-admin');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));

// CSRF Protection للادمن فقط
const csrfProtection = csrf({ 
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  }
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

// تسجيل الدخول للادمن
app.post('/api/admin/login', csrfProtection, (req, res) => {
  const { username, password } = req.body;
  
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign(
      { username: username }, 
      process.env.JWT_SECRET, 
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );
    
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });
    
    return res.json({ success: true, message: 'تم تسجيل الدخول بنجاح' });
  }
  
  res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
});

// طلب اشتراك من العميل (بدون تسجيل دخول)
app.post('/api/subscription-order', async (req, res) => {
  try {
    const { subscriptionId, accountName, email, phone, transferNumber, transferScreenshot } = req.body;
    
    const subscription = subscriptions.find(sub => sub.id === parseInt(subscriptionId));
    
    if (!subscription) {
      return res.status(400).json({ success: false, message: 'الاشتراك غير موجود' });
    }
    
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
        transferScreenshot,
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

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'تم تسجيل الخروج بنجاح' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});