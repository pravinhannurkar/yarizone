import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// ==================== ENVIRONMENT VALIDATION ====================
const requiredEnvVars = ['MONGO_URI', 'JWT_SECRET', 'REFRESH_TOKEN_SECRET', 'CLIENT_URL'];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.warn('⚠️  Missing environment variables:', missingVars.join(', '));
}

// ==================== MONGODB CONNECTION ====================
const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI) {
      console.warn('⚠️  MONGO_URI not set — skipping MongoDB connection');
      return;
    }
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      // Mongoose 6+ doesn't need useNewUrlParser or useUnifiedTopology
    });
    console.log(`✅ MongoDB connected: ${conn.connection.host}`);
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    // Don't exit — app can still run without DB for basic video chat
  }
};
connectDB();

// Handle MongoDB connection errors after initial connect
mongoose.connection.on('error', (err) => {
  console.error('MongoDB runtime error:', err.message);
});
mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB disconnected. Attempting reconnect...');
});

// ==================== CLOUDINARY CONFIG ====================
if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  console.log('☁️  Cloudinary configured');
}

// ==================== EXPRESS APP SETUP ====================
const app = express();
const httpServer = createServer(app);

// Trust proxy (required for Render and other reverse proxies)
app.set('trust proxy', 1);

// Security: Helmet headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", process.env.CLIENT_URL || '*', 'wss:', 'ws:', 'https:', 'http:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:'],
      mediaSrc: ["'self'", 'blob:', 'https:', 'http:'],
      scriptSrc: ["'self'", "'unsafe-inline'"], // Vite/React may need inline
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
}));

// Compression: gzip responses
app.use(compression());

// Cookie parser
app.use(cookieParser());

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CORS: Allow only frontend domain, enable credentials
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
app.use(cors({
  origin: CLIENT_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-requested-with'],
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter); // Apply to API routes

// Stricter limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many auth attempts, please try again later.' },
});
app.use('/api/auth/', authLimiter);

// ==================== SOCKET.IO SETUP ====================
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: CLIENT_URL,
    credentials: true,
    methods: ['GET', 'POST'],
  },
  // Production transports: prefer websocket, fallback to polling
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ==================== JWT MIDDLEWARE ====================
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ success: false, message: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret', (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// ==================== USER MANAGEMENT (Video Chat) ====================
const waitingQueue = [];
const activePairs = new Map();
const userInfo = new Map();

function getRandomUser(excludeSocketId) {
  const available = waitingQueue.filter(
    (id) => id !== excludeSocketId && io.sockets.sockets.get(id)?.connected
  );
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

function createRoomId(id1, id2) {
  return [id1, id2].sort().join('-');
}

function removeFromQueue(socketId) {
  const index = waitingQueue.indexOf(socketId);
  if (index > -1) waitingQueue.splice(index, 1);
}

function disconnectUser(socketId) {
  removeFromQueue(socketId);
  userInfo.delete(socketId);
  for (const [roomId, pair] of activePairs.entries()) {
    if (pair.user1 === socketId || pair.user2 === socketId) {
      const otherUserId = pair.user1 === socketId ? pair.user2 : pair.user1;
      io.to(otherUserId).emit('user-disconnected', { message: 'User disconnected' });
      activePairs.delete(roomId);
      break;
    }
  }
}

function matchUsers() {
  while (waitingQueue.length >= 2) {
    const user1Id = waitingQueue.shift();
    const user2Id = waitingQueue.shift();
    if (!io.sockets.sockets.get(user1Id)?.connected || !io.sockets.sockets.get(user2Id)?.connected) {
      continue;
    }
    const roomId = createRoomId(user1Id, user2Id);
    activePairs.set(roomId, { user1: user1Id, user2: user2Id });
    io.to(user1Id).emit('match-found', { roomId, peer: userInfo.get(user2Id) });
    io.to(user2Id).emit('match-found', { roomId, peer: userInfo.get(user1Id) });
    console.log(`✅ Match created: ${user1Id} <-> ${user2Id}`);
  }
}

// ==================== SOCKET.IO EVENTS ====================
io.on('connection', (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

  socket.on('join', (data) => {
    const { nickname, gender = 'not-specified', location = 'unknown' } = data;
    userInfo.set(socket.id, {
      socketId: socket.id,
      nickname: nickname || `User-${socket.id.slice(0, 6)}`,
      gender,
      location,
      createdAt: new Date(),
    });
    if (!waitingQueue.includes(socket.id)) waitingQueue.push(socket.id);
    console.log(`⏳ User joining queue: ${socket.id} | Queue size: ${waitingQueue.length}`);
    socket.emit('waiting', { message: 'Searching for a match...' });
    matchUsers();
  });

  socket.on('offer', (data) => {
    const { roomId, offer } = data;
    const pair = activePairs.get(roomId);
    if (!pair) return socket.emit('error', { message: 'Room not found' });
    const recipientId = pair.user1 === socket.id ? pair.user2 : pair.user1;
    io.to(recipientId).emit('offer', { roomId, offer });
  });

  socket.on('answer', (data) => {
    const { roomId, answer } = data;
    const pair = activePairs.get(roomId);
    if (!pair) return socket.emit('error', { message: 'Room not found' });
    const recipientId = pair.user1 === socket.id ? pair.user2 : pair.user1;
    io.to(recipientId).emit('answer', { roomId, answer });
  });

  socket.on('ice-candidate', (data) => {
    const { roomId, candidate } = data;
    const pair = activePairs.get(roomId);
    if (!pair) return;
    const recipientId = pair.user1 === socket.id ? pair.user2 : pair.user1;
    io.to(recipientId).emit('ice-candidate', { roomId, candidate });
  });

  socket.on('chat-message', (data) => {
    const { roomId, message } = data;
    const pair = activePairs.get(roomId);
    if (!pair) return;
    const sender = userInfo.get(socket.id);
    const recipientId = pair.user1 === socket.id ? pair.user2 : pair.user1;
    io.to(recipientId).emit('chat-message', {
      sender: sender?.nickname || 'Anonymous',
      message,
      timestamp: new Date(),
    });
  });

  socket.on('skip', () => {
    let currentPair = null;
    let currentRoomId = null;
    for (const [roomId, pair] of activePairs.entries()) {
      if (pair.user1 === socket.id || pair.user2 === socket.id) {
        currentPair = pair;
        currentRoomId = roomId;
        break;
      }
    }
    if (currentPair && currentRoomId) {
      const otherUserId = currentPair.user1 === socket.id ? currentPair.user2 : currentPair.user1;
      io.to(otherUserId).emit('user-skipped', { message: 'User skipped to next' });
      activePairs.delete(currentRoomId);
      if (!waitingQueue.includes(socket.id)) waitingQueue.push(socket.id);
      if (!waitingQueue.includes(otherUserId)) waitingQueue.push(otherUserId);
      socket.emit('waiting', { message: 'Searching for a match...' });
      io.to(otherUserId).emit('waiting', { message: 'Searching for a match...' });
      matchUsers();
      console.log(`⏭️  User ${socket.id} skipped`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`❌ User disconnected: ${socket.id}`);
    disconnectUser(socket.id);
  });

  socket.on('end-call', () => {
    disconnectUser(socket.id);
    console.log(`🛑 User ended call: ${socket.id}`);
  });
});

// ==================== REST API ROUTES ====================

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date(),
    connectedUsers: io.engine.clientsCount,
    waitingUsers: waitingQueue.length,
    activePairs: activePairs.size,
    dbConnected: mongoose.connection.readyState === 1,
  });
});

// Stats
app.get('/stats', (req, res) => {
  res.json({
    connectedUsers: io.engine.clientsCount,
    waitingUsers: waitingQueue.length,
    activePairs: activePairs.size,
    totalUsers: userInfo.size,
    dbConnected: mongoose.connection.readyState === 1,
  });
});

app.get('/health', (req, res) => {
  res.json({ success: true, status: 'ok' });
});

// Auth stubs (integrate with your existing auth controllers)
app.post('/api/auth/register', (req, res) => {
  res.json({ success: true, message: 'Register endpoint — integrate with your auth controller' });
});

app.post('/api/auth/login', (req, res) => {
  res.json({ success: true, message: 'Login endpoint — integrate with your auth controller' });
});

app.post('/api/auth/refresh', (req, res) => {
  res.json({ success: true, message: 'Refresh token endpoint — integrate with your auth controller' });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ success: true, user: req.user });
});

// Upload stub (integrate with your Cloudinary upload controller)
app.post('/api/upload', authenticateToken, (req, res) => {
  res.json({ success: true, message: 'Upload endpoint — integrate with your Cloudinary controller' });
});

// ==================== STATIC FILES (PRODUCTION) ====================
// Serve React frontend build from client/dist
app.use(express.static(path.join(__dirname, '../../client/dist')));

// ==================== ERROR HANDLING ====================
// API 404 handler — catch undefined API routes BEFORE SPA fallback
app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, message: 'API route not found' });
});

// SPA fallback — serve index.html for any non-API route
// This must come AFTER all API routes and the API 404 handler
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../client/dist/index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  const mode = process.env.NODE_ENV || 'development';
  console.log(`\n🎥 YARIZONE SERVER STARTED`);
  console.log(`   Mode: ${mode}`);
  console.log(`   Port: ${PORT}`);
  console.log(`   CORS: ${CLIENT_URL}\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  httpServer.close(() => {
    mongoose.connection.close(false, () => {
      console.log('Server and DB connections closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  httpServer.close(() => {
    mongoose.connection.close(false, () => {
      console.log('Server and DB connections closed');
      process.exit(0);
    });
  });
});

