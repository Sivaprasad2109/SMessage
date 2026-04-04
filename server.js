const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const axios = require('axios');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json());
app.use(rateLimit({ windowMs: 60 * 1000, max: 100 }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/crypto-js", express.static(path.join(__dirname, "node_modules/crypto-js")));

const rooms = new Map(); 
const roomIds = new Map(); 

function generateUniquePasscode() {
  let passcode;
  do {
    passcode = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(passcode));
  return passcode;
}

io.on("connection", (socket) => {
  
  socket.on("createRoom", () => {
    const passcode = generateUniquePasscode();
    const roomId = crypto.randomBytes(16).toString("hex");
    const expiresIn = 15 * 60 * 1000; 
    const expireAt = Date.now() + expiresIn;

    rooms.set(passcode, { roomId, expireAt });
    roomIds.set(roomId, passcode);

    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = "Creator"; // Default name for the creator
    socket.emit("roomCreated", { passcode, roomId, expireAt });

    setTimeout(() => {
      if (rooms.has(passcode)) {
        rooms.delete(passcode);
        roomIds.delete(roomId);
        io.to(roomId).emit("systemMessage", "⚠️ Room expired.");
        io.socketsLeave(roomId);
      }
    }, expiresIn);
  });

  socket.on("joinRoom", ({ passcode, roomId, name }) => {
    let roomData = null;
    if (passcode) roomData = rooms.get(String(passcode).trim());
    else if (roomId) {
      const pCode = roomIds.get(roomId);
      if (pCode) roomData = rooms.get(pCode);
    }
    
    if (!roomData) {
      socket.emit("systemMessage", "Invalid or expired passcode.");
      return;
    }

    // FIX 1: Allow One-to-One only (Max 2 users)
    const currentRoom = io.sockets.adapter.rooms.get(roomData.roomId);
    if (currentRoom && currentRoom.size >= 2) {
      socket.emit("systemMessage", "This room is full. Only 2 people allowed.");
      return;
    }

    socket.join(roomData.roomId);
    socket.roomId = roomData.roomId;
    const currentSize = io.sockets.adapter.rooms.get(roomData.roomId)?.size || 0;
    io.to(roomData.roomId).emit("updateUserCount", currentSize);
    
    // FIX 2: Ensure name is captured correctly (fallback to 'Guest')
    socket.userName = name && name.trim() !== "" ? name : "Guest";

    socket.emit("joinSuccess", { 
        roomId: roomData.roomId, 
        passcode: roomIds.get(roomData.roomId),
        expireAt: roomData.expireAt 
    });

    // FIX 3: Notify everyone in the room that a specific user joined
    io.to(roomData.roomId).emit("systemMessage", `${socket.userName} joined.`);
  });

  socket.on("sendMessage", ({ message, msgId, replyTo }) => {
    if (!socket.roomId) return; 

    // NEW: We now include 'msgId' and 'replyTo' in the emission
    socket.to(socket.roomId).emit("newMessage", { 
        message, 
        from: socket.userName || "Guest",
        msgId: msgId,   // This allows the receiver to "mark as seen"
        replyTo: replyTo // This shows the "Replying to..." text
    });
});

// ADD THIS NEW LISTENER BELOW IT:
socket.on("messageSeen", ({ roomId, msgId }) => {
    // This tells the sender that their specific message was viewed
    socket.to(roomId).emit("msgStatusUpdate", { 
        msgId: msgId, 
        status: "seen" 
    });
});

  // TYPING INDICATIONS
  socket.on("typing", () => { 
    if (socket.roomId) socket.to(socket.roomId).emit("showTyping", { from: socket.userName }); 
  });
  socket.on("stopTyping", () => { 
    if (socket.roomId) socket.to(socket.roomId).emit("hideTyping"); 
  });

  socket.on("disconnect", () => {
    const rId = socket.roomId;
    const uName = socket.userName || "User"; 

    if (rId) {
        // Delay check to see if they actually left or just refreshed
        setTimeout(() => {
            const room = io.sockets.adapter.rooms.get(rId);
            
            // 1. Notify only if someone is still in the room to hear it
            if (room) {
                io.to(rId).emit("systemMessage", `${uName} went offline.`);
                
                // 2. SEND UPDATED COUNT TO REMAINING USER
                const currentSize = room.size;
                io.to(rId).emit("updateUserCount", currentSize);
            }
        }, 2000); 
    }
});

  // DESTROY ROOM LOGIC
  socket.on("destroyRoom", () => {
    const roomId = socket.roomId;
    if (roomId) {
      const passcode = roomIds.get(roomId);
      if (passcode) rooms.delete(passcode);
      roomIds.delete(roomId);
      io.to(roomId).emit("systemMessage", "History deleted by user.");
      io.to(roomId).emit("roomDestroyed");
      io.socketsLeave(roomId);
    }
  });
});

server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));

// KEEP ALIVE
const APP_URL = "https://blinkchat-i72t.onrender.com";
setInterval(async () => {
  try {
    const response = await axios.get(APP_URL);
    console.log(`Keep-Alive: Status ${response.status}`);
  } catch (err) {
    console.error("Keep-Alive Failed");
  }
}, 840000);
