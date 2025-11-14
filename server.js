// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// =====================
// 🧱 Security Middleware
// =====================
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdnjs.cloudflare.com",
          "https://cdn.jsdelivr.net"
        ],
        scriptSrcElem: [
          "'self'",
          "'unsafe-inline'",
          "https://cdnjs.cloudflare.com",
          "https://cdn.jsdelivr.net"
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com"
        ],
        styleSrcElem: [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com"
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        connectSrc: ["'self'", "ws:", "wss:"],
        imgSrc: ["'self'", "data:"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic rate limiter
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// =====================
// 🌐 Static & Libraries
// =====================
app.use(express.static(path.join(__dirname, 'public')));
app.use('/crypto-js', express.static(path.join(__dirname, 'node_modules/crypto-js')));

// =====================
// 💬 Room Storage
// =====================
const rooms = new Map(); // roomId → { createdAt }

// =====================
// ⚡ Socket.IO Handlers
// =====================
io.on('connection', (socket) => {
  console.log('🔗 Socket connected:', socket.id);

  // Create Room
 socket.on('createRoom', () => {
  const roomId = crypto.randomBytes(8).toString('hex');
  const expiresIn = 10 * 60 * 1000; // 🕒 10 minutes (change as needed)
  const expireAt = Date.now() + expiresIn;

  rooms.set(roomId, { createdAt: Date.now(), expireAt });
  socket.emit('roomCreated', { roomId, expireAt });

  // Auto delete after expiry
  setTimeout(() => {
    if (rooms.has(roomId)) {
      rooms.delete(roomId);
      io.to(roomId).emit('systemMessage', '⚠️ Room expired and has been closed.');
      io.socketsLeave(roomId);
    }
  }, expiresIn);
});

  // Join Room
  socket.on('joinRoom', ({ roomId, name }) => {
    if (!roomId || !rooms.has(roomId)) {
      socket.emit('systemMessage', 'Room not found or expired.');
      return;
    }

    const roomSet = io.sockets.adapter.rooms.get(roomId);
    const occupantCount = roomSet ? roomSet.size : 0;

    if (occupantCount >= 2) {
      socket.emit('systemMessage', 'Room is full. Only two users allowed.');
      return;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = name || 'Anonymous';

    console.log(`👤 ${socket.userName} joined room ${roomId}`);

    // Notify both users
    io.to(roomId).emit('systemMessage', `${socket.userName} joined the room.`);
  });

  // Send Message (E2EE payload)
  socket.on('sendMessage', ({ roomId, message }) => {
  const room = socket.roomId;  // Always trust server-stored value

  // Validate room
  if (!room || !rooms.has(room)) {
    socket.emit('systemMessage', 'Invalid or missing room.');
    return;
  }

  // Validate message
  if (!message || typeof message !== "string") {
    socket.emit('systemMessage', 'Empty or invalid message.');
    return;
  }

  const senderName = socket.userName || "User";

  console.log(`📩 Encrypted message from ${senderName} in room ${room}`);

  // Relay encrypted message to the other user only
  socket.to(room).emit('newMessage', {
    message,
    from: senderName,
  });
});



  // Typing indicator
  socket.on('typing', (roomId) => {
    if (!roomId) return;
    socket.to(roomId).emit('showTyping', { from: socket.id });
  });

  socket.on('stopTyping', (roomId) => {
    if (!roomId) return;
    socket.to(roomId).emit('hideTyping', { from: socket.id });
  });

  // Quit room
  socket.on('quitRoom', (roomId) => {
    socket.leave(roomId);
    socket.to(roomId).emit('systemMessage', `${socket.userName} left the room.`);
    const roomSet = io.sockets.adapter.rooms.get(roomId);
    if (!roomSet || roomSet.size === 0) rooms.delete(roomId);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId) {
      socket.to(roomId).emit('systemMessage', `${socket.userName || 'A user'} disconnected.`);
      const roomSet = io.sockets.adapter.rooms.get(roomId);
      if (!roomSet || roomSet.size === 0) rooms.delete(roomId);
    }
    console.log('❌ Disconnected:', socket.userName || socket.id);
  });
});

// =====================
// 🕒 Cleanup (15 min)
///////////////////////
// Clean up expired rooms every minute
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, id) => {
    if (now > room.expireAt) {
      rooms.delete(id);
      io.to(id).emit('systemMessage', '⚠️ Room expired and has been closed.');
      io.socketsLeave(id);
    }
  });
}, 60 * 1000);


// =====================
// 🚀 Start Server
// =====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on ${PORT}`));


