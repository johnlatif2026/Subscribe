const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const csrf = require('csurf');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

// CSRF Protection
const csrfProtection = csrf({ 
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  }
});

// تخزين مؤقت للطلبات (في بيئة حقيقية استخدم قاعدة بيانات)
let subscriptionRequests = [];

// Middleware للتحقق من JWT
const authenticateToken = (req, res, next) => {
  const token = req.cookies.token;
  
  if (!token) {
    return res.redirect('/login.html');
  }
  
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.redirect('/login.html');
    }
    req.user = user;
    next();
  });
};

// Middleware لإرسال إشعارات التيليجرام
const sendTelegramNotification = async (message) => {
  try {
    const TelegramBot = require('node-telegram-bot-api');
    const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
    await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message);
  } catch (error) {
    console.error('خطأ في إرسال إشعار التيليجرام:', error);
  }
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
app.post('/api/login', csrfProtection, (req, res) => {
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

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'تم تسجيل الخروج بنجاح' });
});

app.post('/api/subscription-request', csrfProtection, async (req, res) => {
  const { service, accountName, email, phone, transferNumber, transferScreenshot } = req.body;
  
  const request = {
    id: Date.now(),
    service,
    accountName,
    email,
    phone,
    transferNumber,
    transferScreenshot,
    timestamp: new Date().toISOString(),
    status: 'pending'
  };
  
  subscriptionRequests.push(request);
  
  // إرسال إشعار للادمن على التيليجرام
  const telegramMessage = `
طلب اشتراك جديد:
الخدمة: ${service}
اسم الحساب: ${accountName}
البريد الإلكتروني: ${email}
رقم الهاتف: ${phone}
رقم التحويل: ${transferNumber}
  `;
  
  await sendTelegramNotification(telegramMessage);
  
  res.json({ success: true, message: 'تم استلام طلبك بنجاح وسيتم مراجعته قريباً' });
});

app.get('/api/subscription-requests', authenticateToken, (req, res) => {
  res.json({ success: true, requests: subscriptionRequests });
});

app.listen(PORT, () => {
  console.log(`الخادم يعمل على http://localhost:${PORT}`);
});