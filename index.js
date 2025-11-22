const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg'); // เปลี่ยนจาก sqlite เป็น pg

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    // เวลาขึ้น Render เราต้องยอมรับ Origin จาก Frontend ของเรา
    // ใส่ * ไปก่อนเพื่อความง่าย หรือใส่ URL เว็บจริงทีหลัง
    origin: "*", 
    methods: ["GET", "POST"],
  },
});

// เชื่อมต่อ PostgreSQL
// ถ้ามี Environment Variable 'DATABASE_URL' (บน Render) ให้ใช้
// ถ้าไม่มี ให้ใช้ค่า local (สำหรับการเทสในเครื่องถ้าคุณลง postgres ไว้)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, 
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// สร้างตาราง (Run ครั้งแรก)
(async () => {
  try {
    const client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        creator_id TEXT
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        room_id TEXT,
        x REAL, 
        y REAL, 
        text TEXT, 
        author_id TEXT
      );
    `);
    client.release();
    console.log('✅ PostgreSQL Connected & Tables Ready!');
  } catch (err) {
    console.error('❌ Database Error:', err);
  }
})();

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  const broadcastRoomList = async () => {
    try {
      const result = await pool.query('SELECT * FROM rooms');
      io.emit('update_room_list', result.rows);
    } catch (err) { console.error(err); }
  };

  broadcastRoomList();

  socket.on('join_room', async ({ roomId, userId }) => {
    socket.join(roomId);
    try {
      // Syntax ของ PG ใช้ $1, $2 แทน ?
      let res = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
      let room = res.rows[0];

      if (!room) {
        await pool.query('INSERT INTO rooms (id, creator_id) VALUES ($1, $2)', [roomId, userId]);
        room = { id: roomId, creator_id: userId };
        broadcastRoomList();
      }

      const notesRes = await pool.query('SELECT * FROM notes WHERE room_id = $1', [roomId]);
      socket.emit('load_notes', notesRes.rows);
      socket.emit('room_info', { creatorId: room.creator_id });
    } catch (err) { console.error(err); }
  });

  socket.on('add_note', async ({ roomId, note }) => {
    try {
      await pool.query(
        'INSERT INTO notes (id, room_id, x, y, text, author_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [note.id, roomId, note.x, note.y, note.text, note.authorId]
      );
      const notesRes = await pool.query('SELECT * FROM notes WHERE room_id = $1', [roomId]);
      io.to(roomId).emit('load_notes', notesRes.rows);
    } catch (err) { console.error(err); }
  });

  socket.on('delete_note', async ({ roomId, noteId }) => {
    try {
      await pool.query('DELETE FROM notes WHERE id = $1', [noteId]);
      const notesRes = await pool.query('SELECT * FROM notes WHERE room_id = $1', [roomId]);
      io.to(roomId).emit('load_notes', notesRes.rows);
    } catch (err) { console.error(err); }
  });

  socket.on('delete_room', async ({ roomId, userId }) => {
    try {
      const res = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
      const room = res.rows[0];
      if (room && room.creator_id === userId) {
        await pool.query('DELETE FROM notes WHERE room_id = $1', [roomId]);
        await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
        io.to(roomId).emit('room_deleted');
        broadcastRoomList();
      }
    } catch (err) { console.error(err); }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});