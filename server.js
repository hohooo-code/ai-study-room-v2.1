const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js'); // 引入 Supabase

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. 連線 Supabase 雲端資料庫
// ==========================================
const supabaseUrl = 'https://sljnikfbtsevfogwijqz.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsam5pa2ZidHNldmZvZ3dpanF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMTk5NTgsImV4cCI6MjA4ODY5NTk1OH0.9vD5Ep27xChOCMzmdG55gToGOcy_A8M6c2kMPpwKF_U';
const supabase = createClient(supabaseUrl, supabaseKey);

console.log('✅ 已成功載入 Supabase 雲端資料庫設定。');

// ==========================================
// 2. API 路由設定 (全面改為 Supabase 語法)
// ==========================================

// 取得個人的真實數據
app.get('/api/user-stats', async (req, res) => {
    const username = req.query.username;
    if (!username) return res.status(400).json({ error: '缺少使用者名稱' });

    try {
        // 查詢使用者總表
        const { data: user, error: userErr } = await supabase
            .from('users')
            .select('*')
            .eq('username', username)
            .single();

        // 查詢最近的專注紀錄
        const { data: records, error: recErr } = await supabase
            .from('focus_records')
            .select('*')
            .eq('username', username)
            .order('created_at', { ascending: false })
            .limit(10);

        res.json({
            user: user || { total_seconds: 0, streak: 1, role: 'student' },
            records: records || []
        });
    } catch (err) {
        console.error("API 錯誤:", err);
        res.status(500).json({ error: '資料庫讀取錯誤' });
    }
});

// 儲存時綁定帳號，並更新個人總分
app.post('/api/save-focus', async (req, res) => {
    const { username, roomType, focusSeconds } = req.body;
    if (!username || !roomType || focusSeconds === undefined) {
        return res.status(400).json({ error: '缺少參數' });
    }

    const today = new Date().toISOString().split('T')[0];

    try {
        // 1. 寫入單次專注紀錄
        await supabase.from('focus_records').insert([
            { username: username, room_type: roomType, focus_seconds: focusSeconds }
        ]);

        // 2. 檢查用戶是否存在
        const { data: user } = await supabase
            .from('users')
            .select('*')
            .eq('username', username)
            .single();

        if (user) {
            let newStreak = user.streak;
            // 如果今天還沒登入過，連勝+1
            if (user.last_login !== today) {
                newStreak += 1; 
            }
            // 更新總分與連勝
            await supabase.from('users')
                .update({ 
                    total_seconds: user.total_seconds + focusSeconds, 
                    streak: newStreak, 
                    last_login: today 
                })
                .eq('username', username);
        } else {
            // 新用戶建檔 (預設身分 student)
            await supabase.from('users').insert([
                { username: username, total_seconds: focusSeconds, streak: 1, last_login: today, role: 'student' }
            ]);
        }

        res.json({ message: '儲存成功！' });
    } catch (err) {
        console.error("儲存失敗:", err);
        res.status(500).json({ error: '儲存過程發生錯誤' });
    }
});

// ==========================================
// 3. Socket.io 即時連線邏輯
// ==========================================
let onlineUsers = [];

io.on('connection', (socket) => {
    console.log('🔌 一位指揮官已連線：', socket.id);

    // 處理加入房間
    socket.on('join_room', async (data) => {
        const username = data.name || '神秘學員';
        const today = new Date().toISOString().split('T')[0];

        try {
            // 從雲端查詢使用者真實數據
            const { data: user } = await supabase
                .from('users')
                .select('*')
                .eq('username', username)
                .single();

            let realStreak = 1;
            let realTotalScore = 0;
            let userRole = 'student';

            if (user) {
                realStreak = user.streak;
                realTotalScore = user.total_seconds;
                userRole = user.role || 'student'; // 取出身分 (為未來導師功能做準備)
            } else {
                // 如果是新帳號，幫他建檔到雲端
                await supabase.from('users').insert([
                    { username: username, total_seconds: 0, streak: 1, last_login: today, role: 'student' }
                ]);
            }

            const newUser = {
                id: socket.id,
                name: username,
                goal: data.goal || '專注',
                planTime: data.planTime || 25,
                status: 'FOCUSED',
                score: 0,
                streak: realStreak,       
                totalScore: realTotalScore,
                role: userRole 
            };
            
            onlineUsers.push(newUser);
            io.emit('update_leaderboard', onlineUsers);

        } catch (err) {
            console.error("Socket 資料庫處理錯誤:", err);
        }
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
// 4. 啟動伺服器
// ==========================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => { 
    console.log(`\n========================================`);
    console.log(`🚀 雲端資料庫版伺服器啟動： http://localhost:${PORT}`); 
    console.log(`========================================\n`);
});