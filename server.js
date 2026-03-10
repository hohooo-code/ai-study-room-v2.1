const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. 連線資料庫
// ==========================================
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error('資料庫連線失敗:', err.message);
    else console.log('✅ 已成功連線到 SQLite 資料庫。');
});

// ==========================================
// 2. 初始化資料表 (包含自動升級舊資料庫機制)
// ==========================================
db.serialize(() => {
    // 使用者總表 (紀錄總分與連勝)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        total_seconds INTEGER DEFAULT 0,
        streak INTEGER DEFAULT 1,
        last_login TEXT
    )`);

    // 專注紀錄表
    db.run(`CREATE TABLE IF NOT EXISTS focus_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        room_type TEXT,
        focus_seconds INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 防呆機制：檢查 focus_records 表格結構，確保有 username 欄位
    db.all("PRAGMA table_info(focus_records)", (err, columns) => {
        if (err) {
            console.error("檢查資料表結構失敗:", err);
            return;
        }
        
        if (columns && columns.length > 0) {
            const hasUsername = columns.some(col => col.name === 'username');
            if (!hasUsername) {
                console.log("⚠️ 偵測到舊版 focus_records 資料表，正在自動修復升級...");
                db.run("ALTER TABLE focus_records ADD COLUMN username TEXT", (alterErr) => {
                    if (alterErr) {
                        console.error("❌ 無法升級舊資料表:", alterErr.message);
                    } else {
                        console.log("🛠️ 資料庫已自動升級完成：成功為 focus_records 補上 username 欄位！");
                    }
                });
            } else {
                console.log("✅ 資料表結構檢查完畢 (包含 username)。");
            }
        }
    });
});

// ==========================================
// 3. API 路由設定
// ==========================================

// 取得個人的真實數據
app.get('/api/user-stats', (req, res) => {
    const username = req.query.username;
    if (!username) return res.status(400).json({ error: '缺少使用者名稱' });

    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (err) return res.status(500).json({ error: '資料庫讀取錯誤' });
        
        db.all(`SELECT * FROM focus_records WHERE username = ? ORDER BY created_at DESC LIMIT 10`, [username], (err, records) => {
            if (err) return res.status(500).json({ error: '紀錄讀取錯誤' });
            
            res.json({
                user: user || { total_seconds: 0, streak: 1 },
                records: records || []
            });
        });
    });
});

// 儲存時綁定帳號，並更新個人總分
app.post('/api/save-focus', (req, res) => {
    const { username, roomType, focusSeconds } = req.body;
    if (!username || !roomType || focusSeconds === undefined) {
        return res.status(400).json({ error: '缺少參數' });
    }

    const today = new Date().toISOString().split('T')[0];

    db.serialize(() => {
        // 新增一筆紀錄
        db.run(`INSERT INTO focus_records (username, room_type, focus_seconds) VALUES (?, ?, ?)`, 
            [username, roomType, focusSeconds], 
            function(err) {
                if (err) console.error("❌ 儲存紀錄失敗:", err.message);
            }
        );

        // 更新或建立使用者的總分與連勝天數
        db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, row) => {
            if (err) {
                console.error("讀取用戶資料失敗:", err.message);
                return res.status(500).json({ error: '儲存過程發生錯誤' });
            }

            if (row) {
                let newStreak = row.streak;
                // 如果今天還沒登入過，連勝+1
                if (row.last_login !== today) {
                    newStreak += 1; 
                }
                
                db.run(`UPDATE users SET total_seconds = total_seconds + ?, streak = ?, last_login = ? WHERE username = ?`, 
                    [focusSeconds, newStreak, today, username], function(updateErr) {
                        if(updateErr) console.error("更新用戶資料失敗:", updateErr.message);
                        else res.json({ message: '儲存成功！' });
                    });
            } else {
                db.run(`INSERT INTO users (username, total_seconds, streak, last_login) VALUES (?, ?, 1, ?)`, 
                    [username, focusSeconds, today], function(insertErr) {
                        if(insertErr) console.error("新增用戶資料失敗:", insertErr.message);
                        else res.json({ message: '儲存成功！' });
                    });
            }
        });
    });
});

// ==========================================
// 4. Socket.io 即時連線邏輯
// ==========================================
let onlineUsers = [];

io.on('connection', (socket) => {
    console.log('🔌 一位指揮官已連線：', socket.id);

    // 處理加入房間
    socket.on('join_room', (data) => {
        const username = data.name || '神秘學員';
        const today = new Date().toISOString().split('T')[0];

        // 去資料庫找這個人的真實數據
        db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, row) => {
            let realStreak = 1;
            let realTotalScore = 0;

            if (err) {
                console.error("Socket 讀取用戶資料失敗:", err.message);
            } else if (row) {
                realStreak = row.streak;
                realTotalScore = row.total_seconds;
            } else {
                // 第一次玩的新帳號，幫他建檔
                db.run(`INSERT INTO users (username, total_seconds, streak, last_login) VALUES (?, 0, 1, ?)`, 
                    [username, today], (insertErr) => {
                        if (insertErr) console.error("Socket 幫新用戶建檔失敗:", insertErr.message);
                    });
            }

            const newUser = {
                id: socket.id,
                name: username,
                goal: data.goal || '專注',
                planTime: data.planTime || 25,
                status: 'FOCUSED',
                score: 0,
                streak: realStreak,       // 載入真實連勝
                totalScore: realTotalScore // 載入真實總分
            };
            
            onlineUsers.push(newUser);
            io.emit('update_leaderboard', onlineUsers);
        });
    });

    // 處理狀態回報
    socket.on('report_status', (data) => {
        const user = onlineUsers.find(u => u.id === socket.id);
        if (user) { 
            user.status = data.status; 
            io.emit('update_leaderboard', onlineUsers); 
        }
    });

    // 處理即時互動 (傳送表情)
    socket.on('send_reaction', (data) => {
        console.log(`💬 收到來自 ${data.username} 的表情：${data.emoji}`);
        // 廣播給所有人
        io.emit('receive_reaction', data);
    });

    // 處理斷線
    socket.on('disconnect', () => {
        console.log('👋 指揮官已離開：', socket.id);
        onlineUsers = onlineUsers.filter(u => u.id !== socket.id);
        io.emit('update_leaderboard', onlineUsers);
    });
});

// 處理排行榜分數更新定時器
setInterval(() => {
    let shouldUpdate = false;
    onlineUsers.forEach(user => {
        if (user.status === 'FOCUSED') {
            user.score += 1;
            user.totalScore += 1; 
            shouldUpdate = true;
        }
    });
    if (shouldUpdate) io.emit('update_leaderboard', onlineUsers);
}, 1000);

// ==========================================
// 5. 啟動伺服器 (支援雲端動態分配 Port)
// ==========================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => { 
    console.log(`\n========================================`);
    console.log(`🚀 伺服器已啟動，正在監聽 Port: ${PORT}`); 
    console.log(`========================================\n`);
});