// 在文件最顶部添加这行
require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const axios = require('axios'); // Already required for Spark API
const multer = require('multer');
const multerMemory = multer({ storage: multer.memoryStorage() });
const FormData = require('form-data');
const pinyin = require('pinyin').default || require('pinyin');
const ffmpeg = require('fluent-ffmpeg'); // 需 npm install fluent-ffmpeg
const WebSocket = require('ws'); // 正确写法，只导入类
const cheerio = require('cheerio'); // 需 npm install cheerio
const PORT = 3000;

// 修复：缺少 app 实例化
const app = express();

app.use(cors());
// 修改：增加请求体大小限制，支持大文件上传（如录音文件）
app.use(express.json({ limit: '50mb' })); // 增加到50MB
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname)); // 让 index.html/rank.html 可直接访问

// 修改为 alldata.db
const db = new sqlite3.Database('alldata.db');

// 启动时清理 prerev_master_record 表，用完立刻删除
//db.run('DELETE FROM prerev_master_record', function(err) {
//    if (err) {
//        console.error('[启动清理] 删除 prerev_master_record 失败:', err.message);
//    } else {
//        console.log('[启动清理] 已清空 prerev_master_record 表，删除记录数:', this.changes);
//    }
//});
// 启动时清理 prerev_master_record 表，用完立刻删除

// 初始化表（只需运行一次）
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        type TEXT,          -- e.g., 'wordrecite', 'wordrev', 'kingrev'
        unit TEXT,          -- e.g., 'pep6B_records_U1', 'wordRev4B_Records', 'kingRev6B_Records_U1'
        dateTime TEXT,      -- ISO 8601 format string
        duration TEXT,      -- 'MM:SS' format
        score INTEGER,      -- Number of correct words or maxCombo for kingrev
        totalWords INTEGER, -- Total words in the unit/set
        unitsString TEXT    -- Optional: For wordrev, the combined units string like 'U1U2U3'
    )`);
});

// 新增：巅峰赛开启记录表
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS king_unlocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        gradeKey TEXT,
        unit TEXT,
        unlockedAt TEXT,
        UNIQUE(username, gradeKey, unit)
    )`);
});

// 新增：学生名单表
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS students (
        username TEXT PRIMARY KEY,
        password TEXT,
        isLoggedIn INTEGER DEFAULT 0,
        lastLoginDeviceId TEXT DEFAULT NULL
    )`);
});

// 自动为 students 表添加 lastLogin 字段（兼容旧数据库）
db.serialize(() => {
    db.run(`ALTER TABLE students ADD COLUMN lastLogin TEXT`, () => {});
    db.run(`ALTER TABLE students ADD COLUMN isTeacher INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE students ADD COLUMN credits REAL DEFAULT 0`, () => {});
    // 新增：为永久名单增加 grade_stu 字段
    db.run(`ALTER TABLE students ADD COLUMN grade_stu TEXT`, () => {});
    db.run(`ALTER TABLE students ADD COLUMN settlecredits REAL DEFAULT 0`, () => {});
    // 新增：是否拥有“单词通”属性（isWord: 0/1）
    db.run(`ALTER TABLE students ADD COLUMN isWord INTEGER DEFAULT 0`, () => {});
});

// 新增：注册渠道学生表（增加userId, lastLogin）
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS registered_stu (
        username TEXT PRIMARY KEY,
        password TEXT,
        status INTEGER DEFAULT 0,
        grantTime TEXT,
        registerDate TEXT,
        userId TEXT UNIQUE,
        lastLogin TEXT
    )`);
});

// 修复：自动为老表添加 userId 和 lastLogin 字段（兼容旧数据库）
db.serialize(() => {
    db.run(`ALTER TABLE registered_stu ADD COLUMN userId TEXT`, () => {});
    db.run(`ALTER TABLE registered_stu ADD COLUMN lastLogin TEXT`, () => {});
    db.run(`ALTER TABLE registered_stu ADD COLUMN isTeacher INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE registered_stu ADD COLUMN credits REAL DEFAULT 0`, () => {});
    // 新增：为注册名单增加 grade_stu 字段
    db.run(`ALTER TABLE registered_stu ADD COLUMN grade_stu TEXT`, () => {});
    db.run(`ALTER TABLE registered_stu ADD COLUMN settlecredits REAL DEFAULT 0`, () => {});
    // 新增：是否拥有“单词通”属性（isWord: 0/1）
    db.run(`ALTER TABLE registered_stu ADD COLUMN isWord INTEGER DEFAULT 0`, () => {});
});

// 新增：批量设置单词通属性接口（usernames:[], isWord:0/1, type:'permanent'|'registered'）
app.post('/api/set-wordpass', (req, res) => {
    const { usernames, isWord, type } = req.body;
    if (!Array.isArray(usernames) || (isWord !== 0 && isWord !== 1) || !type) {
        return res.status(400).json({ error: '参数不完整或格式错误' });
    }
    const table = type === 'permanent' ? 'students' : 'registered_stu';
    const placeholders = usernames.map(() => '?').join(',');
    const params = [isWord, ...usernames];
    db.run(
        `UPDATE ${table} SET isWord=? WHERE username IN (${placeholders})`,
        params,
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, changed: this.changes });
        }
    );
});

// 新建 class 表和 class_student 关联表
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS class (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        code TEXT UNIQUE NOT NULL,
        teacher_username TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS class_student (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL,
        student_username TEXT NOT NULL,
        FOREIGN KEY(class_id) REFERENCES class(id)
    )`);
});

// 新增：每季度首日0点自动清理 records 表 开始
function getNextQuarterMidnight() {
    const now = new Date();
    const month = now.getMonth();
    const nextQuarterMonth = month - (month % 3) + 3;
    const year = now.getFullYear() + (nextQuarterMonth > 11 ? 1 : 0);
    const monthFixed = nextQuarterMonth % 12;
    return new Date(year, monthFixed, 1, 0, 0, 0).getTime();
}

function clearQuarterlyData() {
    db.run('DELETE FROM records', function(err) {
        if (err) {
            console.error('[季度清理] 删除 records 失败:', err.message);
        } else {
            console.log('[季度清理] 已清空 records 表，删除记录数:', this.changes);
        }
    });
}

// 每天检查是否到季度首日0点，若到则清理
function scheduleQuarterlyClear() {
    setInterval(() => {
        const now = Date.now();
        const nextQuarter = getNextQuarterMidnight();
        // 如果当前时间在季度首日0点±1小时范围内，则执行清理
        if (Math.abs(now - nextQuarter) < 60 * 60 * 1000) {
            clearQuarterlyData();
        }
    }, 24 * 60 * 60 * 1000); // 每24小时检查一次
}
scheduleQuarterlyClear();

// 新增：每周日24:00自动清理巅峰赛解锁信息
function clearWeeklyData() {
    db.run('DELETE FROM king_unlocks', function(err) {
        if (err) {
            console.error('每周清理king_unlocks表失败:', err.message);
        } else {
            console.log('每周清理king_unlocks表成功');
        }
    });
}
// 新增：每周日24:00自动清理巅峰赛解锁信息 结束

// 工具：检查并自动解除过期权限
function autoRevokeExpiredRegisteredStu(cb) {
    const now = Date.now();
    db.all(`SELECT username, grantTime FROM registered_stu WHERE status=1 AND grantTime IS NOT NULL`, [], (err, rows) => {
        if (err) return cb && cb(err);
        let changed = false;
        rows.forEach(row => {
            const grantTime = new Date(row.grantTime);
            const expireTime = new Date(grantTime);
            expireTime.setMonth(grantTime.getMonth() + 1);
            if (now >= expireTime.getTime()) {
                db.run(`UPDATE registered_stu SET status=0, grantTime=NULL WHERE username=?`, [row.username]);
                changed = true;
            }
        });
        if (cb) cb(null, changed);
    });
}

// 工具：生成当天唯一userId
function generateUserId(callback) {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const dateStr = `${y}${m}${d}`;
    db.get(
        `SELECT COUNT(*) as cnt FROM registered_stu WHERE userId LIKE ?`,
        [`${dateStr}%`],
        (err, row) => {
            if (err) return callback(err);
            const seq = String((row?.cnt || 0) + 1).padStart(3, '0');
            callback(null, `${dateStr}${seq}`);
        }
    );
}

// 计算下一个周一0:00的时间戳
function getNextMondayMidnight() {
    const now = new Date();
    const day = now.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
    const daysUntilMonday = (8 - day) % 7;
    const nextMonday = new Date(now);
    nextMonday.setDate(now.getDate() + daysUntilMonday);
    nextMonday.setHours(0, 0, 0, 0);
    return nextMonday.getTime();
}

// 设置定时器，每周日24:00（即周一0:00）清理数据
function scheduleWeeklyClear() {
    const now = Date.now();
    const nextMonday = getNextMondayMidnight();
    const msUntilNextMonday = nextMonday - now;
    // 只在到达下一个周一0:00时才清理，启动时不立即清理
    if (msUntilNextMonday > 0) {
        setTimeout(() => {
            clearWeeklyData();
            setInterval(clearWeeklyData, 7 * 24 * 60 * 60 * 1000);
        }, msUntilNextMonday);
    } else {
        // 理论上不会走到这里，保险起见
        setInterval(clearWeeklyData, 7 * 24 * 60 * 60 * 1000);
    }
}
scheduleWeeklyClear();

// 每天24:00清理所有年级的大师赛解锁记录（即 kingRev*_Master 的解锁信息）
function clearDailyMasterUnlocks() {
    db.run(
        `DELETE FROM king_unlocks WHERE gradeKey LIKE 'kingRev%_Master'`,
        function(err) {
            if (err) {
                console.error('每日清理所有年级大师赛解锁失败:', err.message);
            } else {
                console.log('每日清理所有年级大师赛解锁成功');
            }
        }
    );
}

// 服务器启动时立即清理一次
//clearDailyMasterUnlocks();

// 计算下一个0点的时间戳
function getNextMidnight() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    return next.getTime();
}

// 设置定时器，每天24:00清理 kingRev6B_Master 解锁
function scheduleDailyMasterUnlockClear() {
    const now = Date.now();
    const nextMidnight = getNextMidnight();
    const msUntilNextMidnight = nextMidnight - now;
    setTimeout(() => {
        clearDailyMasterUnlocks();
        setInterval(clearDailyMasterUnlocks, 24 * 60 * 60 * 1000);
    }, msUntilNextMidnight);
}
scheduleDailyMasterUnlockClear();

// 保存记录 (Simplified)
app.post('/api/uploadRecords', (req, res) => {
    const { username, type, unit, records } = req.body;
    if (!username || !type || !unit || !Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ error: '参数不完整或格式错误' });
    }
    const r = records[0];
    if (!r || typeof r.dateTime !== 'string' || typeof r.duration !== 'string' || typeof r.score !== 'number' || typeof r.totalWords !== 'number') {
        return res.status(400).json({ error: '记录数据格式无效' });
    }
    
    // 原有逻辑：保存记录到数据库
    const stmt = db.prepare(`INSERT INTO records (username, type, unit, dateTime, duration, score, totalWords, unitsString) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(username, type, unit, r.dateTime, r.duration, r.score, r.totalWords, r.unitsString || '', function(err) {
        if (err) {
            stmt.finalize();
            return res.status(500).json({ error: '数据库插入失败' });
        }
        stmt.finalize();
        
        // 新增逻辑：只在大师赛(masterrev)且100%正确率时处理词汇掌握
        try {
            if (type === 'masterrev') {
                // 支持前端传 correctPercent 或 score/totalWords
                const correctPercent = typeof r.correctPercent === 'number'
                    ? r.correctPercent
                    : (typeof r.score === 'number' && typeof r.totalWords === 'number' && r.totalWords > 0
                        ? (r.score / r.totalWords) * 100 : 0);
                if (correctPercent === 100) {
                    // 推荐前端上传 words: [单词数组]，否则无法自动获取
                    const words = Array.isArray(r.words) ? r.words : [];
                    // 页面title和单元信息
                    const pageTitle = r.pageTitle || unit || '';
                    const unitInfo = r.unitInfo || unit || '';
                    const masteredAt = r.dateTime || new Date().toISOString();
                    if (words.length > 0) {
                        insertMasteredWords(username, words, masteredAt, pageTitle, unitInfo, () => {});
                    }
                }
            }
        } catch (e) {
            // 忽略异常，保证主流程不受影响
            console.error('词汇掌握写入失败:', e);
        }
        
        res.json({ success: true, id: this.lastID });
    });
});

// 查询记录 for rank.html (by type and unit)
app.get('/api/records', (req, res) => {
    const { unit, type } = req.query;
    if (!unit || !type) {
        return res.status(400).json({ error: '缺少 unit 或 type 参数' });
    }
    db.all(`SELECT * FROM records WHERE unit=? AND type=?`, [unit, type], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// 新增: 查询特定用户的记录 (for userdata.html)
app.get('/api/records/user', (req, res) => {
    const { username, type, unit } = req.query; // 'unit' here is the gradeKey like 'pep6B_records'

    if (!username || !type || !unit) {
        return res.status(400).json({ error: '缺少 username, type 或 unit 参数' });
    }

    // Use LIKE to match the beginning of the unit string (e.g., 'pep6B_records%')
    const unitPattern = `${unit}%`;

    db.all(`SELECT * FROM records WHERE username = ? AND type = ? AND unit LIKE ? ORDER BY dateTime DESC`,
        [username, type, unitPattern],
        (err, rows) => {
            if (err) {
                console.error("Error fetching user records:", err.message);
                return res.status(500).json({ error: err.message });
            }
            console.log(`Fetched ${rows.length} records for user: ${username}, type: ${type}, unit pattern: ${unitPattern}`); // Debug log
            res.json(rows);
        });
});

// 查询所有单元 (No changes needed here, but ensure it returns distinct units correctly)
app.get('/api/units', (req, res) => {
    const { type } = req.query;
    if (!type) {
        return res.status(400).json({ error: '缺少 type 参数' });
    }
    // Extract the base unit name (e.g., U1, U2) from the combined unit identifier
    // This might need adjustment depending on how you want to display units
    // For now, let's assume the format is always GRADE_U<Number> for wordrecite
    let query = `SELECT DISTINCT unit FROM records WHERE type=?`;
    if (type === 'wordrecite') {
        // Extract the part after the last underscore (e.g., U1 from pep6B_records_U1)
        // Note: This might not be efficient for large datasets. Consider storing unit separately if needed.
        query = `SELECT DISTINCT SUBSTR(unit, INSTR(unit, '_U') + 1) as unitName FROM records WHERE type=? AND unit LIKE '%\\_U%' ESCAPE '\\'`;
    } else if (type === 'wordrev' || type === 'kingrev') {
        // For wordrev and kingrev, the 'unit' field might store the grade key, and 'unitsString' the actual units.
        // Adjust based on how you store wordrev/kingrev units. If 'unit' stores the grade key:
        query = `SELECT DISTINCT unit FROM records WHERE type=?`;
    }

    db.all(query, [type], (err, rows) => {
        if (err) {
            console.error("Error fetching units:", err.message);
            return res.status(500).json({ error: err.message });
        }
        // Map to the expected format { key: ..., name: ... }
        const unitsList = rows.map(r => ({
            key: r.unitName || r.unit, // Use unitName if extracted, otherwise use unit
            name: r.unitName || r.unit  // Display the same value
        })).filter(u => u.key); // Filter out any null/empty keys

        // For wordrecite, ensure units are sorted correctly (U1, U2, U10)
        if (type === 'wordrecite') {
            unitsList.sort((a, b) => {
                const numA = parseInt(a.key.replace('U', ''), 10);
                const numB = parseInt(b.key.replace('U', ''), 10);
                return numA - numB;
            });
        }

        console.log(`Fetched units for type ${type}:`, unitsList); // Debug log
        res.json(unitsList);
    });
});

// 获取所有可用年级（gradeKey）
app.get('/api/available-grades', (req, res) => {
    const { type } = req.query;
    if (!type) {
        return res.status(400).json({ error: '缺少 type 参数' });
    }
    // gradeKey 为 unit 字段下划线前面的部分
    db.all(`SELECT DISTINCT unit FROM records WHERE type=?`, [type], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // 例如 pep6B_records_U1 => pep6B_records
        const gradeKeys = Array.from(new Set(
            rows.map(r => (r.unit || '').split('_U')[0]).filter(Boolean)
        ));
        res.json(gradeKeys);
    });
});

// 获取某年级下所有可用单元
app.get('/api/available-units', (req, res) => {
    const { type, gradeKey } = req.query;
    if (!type || !gradeKey) {
        return res.status(400).json({ error: '缺少 type 或 gradeKey 参数' });
    }
    // 例如 pep6B_records_U1 => U1
    db.all(`SELECT DISTINCT unit FROM records WHERE type=? AND unit LIKE ?`, [type, `${gradeKey}_U%`], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const units = rows.map(r => {
            const parts = (r.unit || '').split('_U');
            return parts.length > 1 ? `U${parts[1]}` : r.unit;
        }).filter(Boolean);
        res.json(units);
    });
});

// 新增：清除所有记录接口
app.post('/api/clear-all-records', (req, res) => {
    db.run('DELETE FROM records', function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        // 手动清理时清零所有用户积分和永久积分
        db.run('UPDATE students SET credits = 0, settlecredits = 0', function(err2) {
            if (err2) return res.status(500).json({ success: false, error: err2.message });
            db.run('UPDATE registered_stu SET credits = 0, settlecredits = 0', function(err3) {
                if (err3) return res.status(500).json({ success: false, error: err3.message });
                // 明确设置响应头为 JSON，防止 Express 静态中间件拦截
                res.setHeader('Content-Type', 'application/json');
                res.json({ success: true });
            });
        });
    });
});

// 新增：清除所有巅峰赛解锁信息接口
app.post('/api/clear-all-king-unlocks', (req, res) => {
    db.run('DELETE FROM king_unlocks', function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.setHeader('Content-Type', 'application/json');
        res.json({ success: true });
    });
});

// 新增：导出全部数据库数据接口
app.get('/api/export-all-records', (req, res) => {
    db.all('SELECT * FROM records', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.setHeader('Content-Type', 'application/json');
        res.json({ records: rows });
    });
});

// 新增：导出alldata.db所有主要表数据（含作业平台相关表）
app.get('/api/export-all-alldata', (req, res) => {
    const tables = [
        'records',
        'students',
        'registered_stu',
        'king_unlocks',
        'task',
        'task_assignment',
        'student_task_submit',
        'class',
        'class_student',
        'messages'  // 新增：包含留言板数据
    ];
    let result = {};
    let pending = tables.length;
    tables.forEach(table => {
        db.all(`SELECT * FROM ${table}`, [], (err, rows) => {
            result[table] = rows || [];
            if (--pending === 0) {
                res.setHeader('Content-Type', 'application/json');
                res.json(result);
            }
        });
    });
});

// 新增：巅峰赛开启上报接口
app.post('/api/unlock-king', (req, res) => {
    const { username, gradeKey, unit, unlockedAt } = req.body;
    if (!username || !gradeKey || !unit || !unlockedAt) {
        return res.status(400).json({ error: '参数不完整' });
    }
    // 插入或更新（已存在则更新时间）
    db.run(
        `INSERT INTO king_unlocks (username, gradeKey, unit, unlockedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(username, gradeKey, unit) DO UPDATE SET unlockedAt=excluded.unlockedAt`,
        [username, gradeKey, unit, unlockedAt],
        function(err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true });
        }
    );
});

// 新增：查询某用户某年级已解锁巅峰赛单元接口
app.get('/api/king-unlocked-units', (req, res) => {
    const { username, gradeKey } = req.query;
    if (!username || !gradeKey) {
        return res.status(400).json({ error: '缺少 username 或 gradeKey 参数' });
    }
    db.all(
        `SELECT unit FROM king_unlocks WHERE username = ? AND gradeKey = ? AND unlockedAt IS NOT NULL`,
        [username, gradeKey],
        (err, rows) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            // 返回数字编号（如1,2,3...），如果存的是字符串也直接返回
            const units = rows.map(r => {
                // 兼容数字和字符串
                const n = Number(r.unit);
                return isNaN(n) ? r.unit : n;
            });
            res.json({ units });
        }
    );
});

// 新增：获取所有学生名单（不返回密码）
app.get('/api/students', (req, res) => {
    db.all(`SELECT username FROM students`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(r => r.username));
    });
});

// 新增：获取所有注册学生名单（含权限状态、userId、lastLogin、isTeacher、isWord）
app.get('/api/registered-stu', (req, res) => {
    autoRevokeExpiredRegisteredStu(() => {
        db.all(`SELECT username, status, grantTime, registerDate, userId, lastLogin, isTeacher, isWord, password FROM registered_stu`, [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        });
    });
});

// 新增：获取所有有权限的注册学生名单
app.get('/api/registered-stu/active', (req, res) => {
    autoRevokeExpiredRegisteredStu(() => {
        db.all(`SELECT username, grantTime FROM registered_stu WHERE status=1`, [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        });
    });
});

// 新增：注册学生（注册时写入registerDate, userId, lastLogin=null）
app.post('/api/registered-stu/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: '缺少参数' });
    }
    const now = new Date().toISOString();
    generateUserId((err, userId) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run(
            `INSERT INTO registered_stu (username, password, status, grantTime, registerDate, userId, lastLogin) VALUES (?, ?, 0, NULL, ?, ?, NULL)`,
            [username, password, now, userId],
            function(err2) {
                if (err2) {
                    if (err2.message.includes('UNIQUE')) {
                        return res.status(409).json({ error: '用户名已存在' });
                    }
                    return res.status(500).json({ error: err2.message });
                }
                res.json({ success: true, userId });
            }
        );
    });
});

// 新增：手动赋予注册学生权限（支持grantTime/status直接设置）
app.post('/api/registered-stu/grant', (req, res) => {
    const { username, grantTime, status } = req.body;
    if (!username) return res.status(400).json({ error: '缺少参数' });
    // 如果grantTime/status都没传，则为普通授权（延长1个月），否则直接设置
    if (grantTime !== undefined && status !== undefined) {
        db.run(
            `UPDATE registered_stu SET status=?, grantTime=? WHERE username=?`,
            [status, grantTime, username],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) return res.status(404).json({ error: '用户不存在' });
                res.json({ success: true, grantTime });
            }
        );
    } else {
        // 兼容老接口：直接赋予当前时间
        const now = new Date().toISOString();
        db.run(
            `UPDATE registered_stu SET status=1, grantTime=? WHERE username=?`,
            [now, username],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) return res.status(404).json({ error: '用户不存在' });
                res.json({ success: true, grantTime: now });
            }
        );
    }
});

// 新增：登录接口（带设备ID，互踢）-- 增加lastLogin写入
app.post('/api/login', (req, res) => {
    const { username, password, deviceId } = req.body;
    if (!username || !password || !deviceId) {
        return res.status(400).json({ error: '缺少参数' });
    }
    db.get(`SELECT * FROM students WHERE username = ?`, [username], (err, student) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!student) return res.status(404).json({ error: '用户不存在' });
        if (student.password !== password) return res.status(401).json({ error: '密码错误' });

        const now = new Date().toISOString();
        db.run(
            `UPDATE students SET isLoggedIn = 1, lastLoginDeviceId = ?, lastLogin = ? WHERE username = ?`,
            [deviceId, now, username],
            function(err2) {
                if (err2) return res.status(500).json({ error: err2.message });
                res.json({
                    success: true,
                    username,
                    isTeacher: !!student.isTeacher,
                    regExpireDate: null,
                    grade_stu: student.grade_stu || ''
                });
            }
        );
    });
});

// 修复：注册学生登录接口，允许无权限也能登录，且密码校验逻辑与前端一致
app.post('/api/registered-stu/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '缺少参数' });
    db.get(`SELECT * FROM registered_stu WHERE username=?`, [username], (err, stu) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!stu) return res.status(404).json({ error: '用户不存在' });
        if (stu.password !== password) return res.status(401).json({ error: '密码错误' });
        const now = new Date().toISOString();
        let regExpireDate = null;
        if (stu.status === 1 && stu.grantTime) {
            const grant = new Date(stu.grantTime);
            const expire = new Date(grant);
            expire.setMonth(grant.getMonth() + 1);
            regExpireDate = expire.toISOString();
        }
        db.run(`UPDATE registered_stu SET lastLogin=? WHERE username=?`, [now, username], function(err2) {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({
                success: true,
                username,
                userId: stu.userId,
                registerDate: stu.registerDate,
                lastLogin: now,
                status: stu.status,
                grantTime: stu.grantTime,
                isTeacher: !!stu.isTeacher,
                regExpireDate,
                grade_stu: stu.grade_stu || ''
            });
        });
    });
});

// 新增：删除注册学生接口
app.post('/api/registered-stu/delete', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: '缺少参数' });
    db.run(`DELETE FROM registered_stu WHERE username=?`, [username], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// 新增：登录接口（带设备ID，互踢）-- 增加lastLogin写入
app.post('/api/login', (req, res) => {
    const { username, password, deviceId } = req.body;
    if (!username || !password || !deviceId) {
        return res.status(400).json({ error: '缺少参数' });
    }
    db.get(`SELECT * FROM students WHERE username = ?`, [username], (err, student) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!student) return res.status(404).json({ error: '用户不存在' });
        if (student.password !== password) return res.status(401).json({ error: '密码错误' });

        // 互踢逻辑：更新isLoggedIn和lastLoginDeviceId和lastLogin
        const now = new Date().toISOString();
        db.run(
            `UPDATE students SET isLoggedIn = 1, lastLoginDeviceId = ?, lastLogin = ? WHERE username = ?`,
            [deviceId, now, username],
            function(err2) {
                if (err2) return res.status(500).json({ error: err2.message });
                res.json({ success: true, username });
            }
        );
    });
});

// 新增：登出接口
app.post('/api/logout', (req, res) => {
    const { username, deviceId } = req.body;
    if (!username || !deviceId) {
        return res.status(400).json({ error: '缺少参数' });
    }
    // 只有当前设备才能登出
    db.get(`SELECT lastLoginDeviceId FROM students WHERE username = ?`, [username], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: '用户不存在' });
        if (row.lastLoginDeviceId !== deviceId) return res.status(403).json({ error: '只能由当前设备登出' });
        db.run(`UPDATE students SET isLoggedIn = 0, lastLoginDeviceId = NULL WHERE username = ?`, [username], function(err2) {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ success: true });
        });
    });
});

// 新增：检查登录状态接口（前端定时轮询）
app.post('/api/check-login-status', (req, res) => {
    const { username, deviceId } = req.body;
    if (!username || !deviceId) {
        return res.status(400).json({ error: '缺少参数' });
    }
    db.get(`SELECT isLoggedIn, lastLoginDeviceId FROM students WHERE username = ?`, [username], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: '用户不存在' });
        // 只要不是本设备，且isLoggedIn=1，则被踢下线
        if (row.isLoggedIn && row.lastLoginDeviceId !== deviceId) {
            return res.json({ loggedIn: false, kicked: true });
        }
        res.json({ loggedIn: !!row.isLoggedIn, kicked: false });
    });
});

// 新增：修改密码接口
app.post('/api/update-password', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(400).json({ success: false, error: '缺少参数' });
    }
    // 先尝试更新 students
    db.run(
        `UPDATE students SET password = ? WHERE username = ?`,
        [password, username],
        function(err) {
            res.setHeader('Content-Type', 'application/json');
            if (err) {
                return res.status(500).json({ success: false, error: err.message });
            }
            if (this.changes > 0) {
                return res.json({ success: true });
            }
            // 如果 students 没有，尝试更新 registered_stu
            db.run(
                `UPDATE registered_stu SET password = ? WHERE username = ?`,
                [password, username],
                function(err2) {
                    if (err2) {
                        return res.status(500).json({ success: false, error: err2.message });
                    }
                    if (this.changes > 0) {
                        return res.json({ success: true });
                    }
                    return res.status(404).json({ success: false, error: '用户不存在' });
                }
            );
        }
    );
});

// 新增：写入export.html的markdown数据
app.post('/api/export-html', (req, res) => {
    const { markdown } = req.body;
    if (typeof markdown !== 'string' || !markdown.trim()) {
        return res.status(400).json({ error: '缺少markdown内容' });
    }
    const htmlPath = path.join(__dirname, 'export.html');
    fs.readFile(htmlPath, 'utf8', (err, content) => {
        if (err) return res.status(500).json({ error: '读取export.html失败' });
        // 用正则替换 const markdown = `...`;
        const newContent = content.replace(
            /const markdown = `[\s\S]*?`;/,
            `const markdown = \`${markdown.replace(/`/g, '\\`')}\`;`
        );
        fs.writeFile(htmlPath, newContent, 'utf8', (err2) => {
            if (err2) return res.status(500).json({ error: '写入export.html失败' });
            res.json({ success: true });
        });
    });
});

// 新增：获取所有永久名单（students表，不含密码，含lastLogin、isTeacher、isWord）
app.get('/api/permanent-stu', (req, res) => {
    db.all(`SELECT username, lastLogin, isTeacher, isWord, password FROM students`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 新增：批量设置老师属性接口
app.post('/api/set-teacher', (req, res) => {
    const { usernames, isTeacher, type } = req.body; // type: 'permanent' or 'registered'
    if (!Array.isArray(usernames) || typeof isTeacher !== 'number' || !type) {
        return res.status(400).json({ error: '参数不完整' });
    }
    const table = type === 'permanent' ? 'students' : 'registered_stu';
    const placeholders = usernames.map(() => '?').join(',');
    db.run(
        `UPDATE ${table} SET isTeacher=? WHERE username IN (${placeholders})`,
        [isTeacher, ...usernames],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, changed: this.changes });
        }
    );
});

// 新增：积分等级分数映射
function getWordrevCreditByRank(rank) {
    // 黄金0.1，铂金0.2，钻石0.4，星耀0.7，王者1，王者N星1.N
    if (!rank) return 0;
    if (rank.startsWith('王者')) {
        if (rank === '王者') return 1;
        const m = rank.match(/^王者(\d+)星$/);
        if (m) return 1 + parseInt(m[1], 10) / 10;
        return 1;
    }
    if (rank.startsWith('星耀')) return 0.7;
    if (rank.startsWith('钻石')) return 0.4;
    if (rank.startsWith('铂金')) return 0.2;
    if (rank.startsWith('黄金')) return 0.1;
    return 0;
}
function getKingrevCreditByRank(rank) {
    // 白银0.1，黄金0.2，铂金0.4，钻石0.7，星耀1.1，王者1.6，王者N星1.6+N*0.1
    if (!rank) return 0;
    if (rank.startsWith('王者')) {
        if (rank === '王者') return 1.6;
        const m = rank.match(/^王者(\d+)星$/);
        if (m) return 1.6 + parseInt(m[1], 10) * 0.1;
        return 1.6;
    }
    if (rank.startsWith('星耀')) return 1.1;
    if (rank.startsWith('钻石')) return 0.7;
    if (rank.startsWith('铂金')) return 0.4;
    if (rank.startsWith('黄金')) return 0.2;
    if (rank.startsWith('白银')) return 0.1;
    return 0;
}

// 计算等级
function calcWordrevRank(score, duration, totalWords) {
    if (!score || !duration || !totalWords) return '';
    const parts = duration.split(':');
    const sec = parseInt(parts[0]) * 60 + parseInt(parts[1]);
    const kingTime = Math.floor(totalWords * 1.2);
    if (sec <= kingTime) {
        const starDiff = kingTime - sec;
        return starDiff === 0 ? "王者" : `王者${starDiff}星`;
    } else {
        const overTime = sec - kingTime;
        const drop = Math.floor(overTime / 10);
        const remainder = overTime % 10;
        const levelOrder = ["星耀", "钻石", "铂金", "黄金", "白银", "青铜"];
        if (drop >= levelOrder.length) return "青铜";
        return remainder <= 5 ? `${levelOrder[drop]}2阶` : `${levelOrder[drop]}1阶`;
    }
}
function calcKingrevRank(score, duration, totalWords) {
    if (!score || !duration || !totalWords) return '';
    const parts = duration.split(':');
    const sec = parseInt(parts[0]) * 60 + parseInt(parts[1]);
    const kingTime = Math.round(totalWords * 1.2);
    if (sec <= kingTime) {
        const starDiff = kingTime - sec;
        return starDiff === 0 ? "王者" : `王者${starDiff}星`;
    } else {
        const overTime = sec - kingTime;
        const drop = Math.floor(overTime / 6);
        const remainder = overTime % 6;
        const levelOrder = ["星耀", "钻石", "铂金", "黄金", "白银", "青铜"];
        if (drop >= levelOrder.length) return "青铜";
        return remainder < 3 ? `${levelOrder[drop]}2阶` : `${levelOrder[drop]}1阶`;
    }
}

// 新增：获取用户永久积分 settlecredits
app.get('/api/get-settlecredits', (req, res) => {
    const { username } = req.query;
    if (!username) {
        return res.status(400).json({ error: '缺少用户名参数' });
    }
    db.get(`SELECT settlecredits FROM students WHERE username = ?`, [username], (err, student_row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (student_row) return res.json({ settlecredits: student_row.settlecredits || 0 });
        db.get(`SELECT settlecredits FROM registered_stu WHERE username = ?`, [username], (err2, reg_row) => {
            if (err2) return res.status(500).json({ error: err2.message });
            if (reg_row) return res.json({ settlecredits: reg_row.settlecredits || 0 });
            return res.json({ settlecredits: 0 });
        });
    });
});

// 修改：/api/user-credits 返回 settlecredits 字段，且不重复累加
app.get('/api/user-credits', async (req, res) => {
    db.all(
        `SELECT username, grade_stu, credits, settlecredits FROM students
         UNION
         SELECT username, grade_stu, credits, settlecredits FROM registered_stu`,
        [],
        (err, users) => {
            if (err) return res.status(500).json([]);
            if (!Array.isArray(users) || users.length === 0) return res.json([]);
            db.all(`SELECT * FROM records`, [], (err2, records) => {
                if (err2) return res.status(500).json([]);
                const result = [];
                let pending = users.length;
                if (pending === 0) return res.json([]);
                users.forEach(u => {
                    const username = u.username;
                    const grade_stu = u.grade_stu || '';
                    let credits = 0;
                    if (!grade_stu) {
                        updateCreditsAndSettle(username, 0, u.settlecredits || 0, () => {
                            result.push({ username, grade_stu: '', credits: 0, settlecredits: u.settlecredits || 0 });
                            if (--pending === 0) res.json(result);
                        });
                        return;
                    }
                    // === 支持多个前缀的统计 ===
                    const conf = gradeCreditConfig[grade_stu];
                    let wordrevRecords = [];
                    let kingrevRecords = [];
                    if (conf) {
                        if (Array.isArray(conf.wordrevPrefixes)) {
                            wordrevRecords = records.filter(r =>
                                r.username === username &&
                                r.type === 'wordrev' &&
                                r.unit && conf.wordrevPrefixes.some(prefix => r.unit.startsWith(prefix))
                            );
                        } else if (conf.wordrevPrefix) {
                            wordrevRecords = records.filter(r =>
                                r.username === username &&
                                r.type === 'wordrev' &&
                                r.unit && r.unit.startsWith(conf.wordrevPrefix)
                            );
                        }
                        if (Array.isArray(conf.kingrevPrefixes)) {
                            kingrevRecords = records.filter(r =>
                                r.username === username &&
                                r.type === 'kingrev' &&
                                r.unit && conf.kingrevPrefixes.some(prefix => r.unit.startsWith(prefix))
                            );
                        } else if (conf.kingrevPrefix) {
                            kingrevRecords = records.filter(r =>
                                r.username === username &&
                                r.type === 'kingrev' &&
                                r.unit && r.unit.startsWith(conf.kingrevPrefix)
                            );
                        }
                    } else {
                        wordrevRecords = [];
                        kingrevRecords = [];
                    }
                    // 计算wordrev积分
                    let wordrevMap = {};
                    wordrevRecords.forEach(r => {
                        if (!r.dateTime || !r.duration || !r.score || !r.totalWords) return;
                        const date = new Date(r.dateTime).toLocaleDateString();
                        const unit = r.unit;
                        const key = date + '_' + unit;
                        const rank = calcWordrevRank(r.score, r.duration, r.totalWords);
                        const credit = getWordrevCreditByRank(rank);
                        if (!wordrevMap[key] || credit > wordrevMap[key]) {
                            wordrevMap[key] = credit;
                        }
                    });
                    // 计算kingrev积分
                    let kingrevMap = {};
                    kingrevRecords.forEach(r => {
                        if (!r.dateTime || !r.duration || !r.score || !r.totalWords) return;
                        const date = new Date(r.dateTime).toLocaleDateString();
                        const unit = r.unit;
                        const key = date + '_' + unit;
                        const rank = calcKingrevRank(r.score, r.duration, r.totalWords);
                        const credit = getKingrevCreditByRank(rank);
                        if (!kingrevMap[key] || credit > kingrevMap[key]) {
                            kingrevMap[key] = credit;
                        }
                    });
                    credits =
                        Object.values(wordrevMap).reduce((a, b) => a + b, 0) +
                        Object.values(kingrevMap).reduce((a, b) => a + b, 0);
                    credits = Math.round(credits * 100) / 100;
                    // 修正：用数据库中的 credits 字段做对比
                    const prevCredits = typeof u.credits === 'number' ? u.credits : (parseFloat(u.credits) || 0);
                    const prevSettle = typeof u.settlecredits === 'number' ? u.settlecredits : (parseFloat(u.settlecredits) || 0);
                    let delta = credits - prevCredits;
                    if (delta < 0) delta = 0;
                    // 只有 credits 变化时才累加 settlecredits
                    const newSettle = prevSettle + delta;
                    // 只有 credits 或 settlecredits 变化时才写入数据库
                    if (credits !== prevCredits || newSettle !== prevSettle) {
                        updateCreditsAndSettle(username, credits, Math.round(newSettle * 100) / 100, () => {
                            result.push({ username, grade_stu, credits, settlecredits: Math.round(newSettle * 100) / 100 });
                            if (--pending === 0) res.json(result);
                        });
                    } else {
                        result.push({ username, grade_stu, credits, settlecredits: prevSettle });
                        if (--pending === 0) res.json(result);
                    }
                });
            });
        }
    );
});

function updateCreditsAndSettle(username, credits, settlecredits, cb) {
    db.run(`UPDATE students SET credits=?, settlecredits=? WHERE username=?`, [credits, settlecredits, username], function(err) {
        if (err) return cb && cb();
        if (this.changes > 0) return cb && cb();
        db.run(`UPDATE registered_stu SET credits=?, settlecredits=? WHERE username=?`, [credits, settlecredits, username], function(err2) {
            cb && cb();
        });
    });
}

// 新增：修改学生年级接口
app.post('/api/update-grade', (req, res) => {
    const { username, grade_stu } = req.body;
    if (!username) return res.status(400).json({ error: '缺少参数' });
    // 先尝试更新 students
    db.run(`UPDATE students SET grade_stu=? WHERE username=?`, [grade_stu || null, username], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes > 0) return res.json({ success: true });
        // 如果 students 没有，尝试更新 registered_stu
        db.run(`UPDATE registered_stu SET grade_stu=? WHERE username=?`, [grade_stu || null, username], function(err2) {
            if (err2) return res.status(500).json({ error: err2.message });
            if (this.changes > 0) return res.json({ success: true });
            res.status(404).json({ error: '用户不存在' });
        });
    });
});

// 新增：获取用户积分接口
app.get('/api/get-points', (req, res) => {
    const { username } = req.query;
    if (!username) {
        return res.status(400).json({ error: '缺少用户名参数' });
    }

    db.get(`SELECT credits FROM students WHERE username = ?`, [username], (err, student_row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (student_row) {
            return res.json({ points: student_row.credits || 0 });
        }
        // If not in students, check registered_stu
        db.get(`SELECT credits FROM registered_stu WHERE username = ?`, [username], (err_reg, reg_row) => {
            if (err_reg) {
                return res.status(500).json({ error: err_reg.message });
            }
            if (reg_row) {
                return res.json({ points: reg_row.credits || 0 });
            }
            // User not found in either table
            return res.json({ points: 0 });
        });
    });
});

// 新增：积分兑换接口
app.post('/api/exchange-points', (req, res) => {
    const { username, points } = req.body;
    if (!username || typeof points !== 'number' || points <= 0) {
        return res.status(400).json({ success: false, error: '参数无效' });
    }
    const findUserAndUpdateSettle = (table) => {
        db.get(`SELECT settlecredits FROM ${table} WHERE username = ?`, [username], (err, row) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            if (!row) {
                if (table === 'students') return findUserAndUpdateSettle('registered_stu');
                return res.status(404).json({ success: false, error: '用户不存在' });
            }
            const currentSettle = row.settlecredits || 0;
            if (currentSettle < points) {
                return res.status(400).json({ success: false, error: '积分不足' });
            }
            const newSettle = Math.round((currentSettle - points) * 100) / 100;
            db.run(`UPDATE ${table} SET settlecredits = ? WHERE username = ?`, [newSettle, username], function(updateErr) {
                if (updateErr) return res.status(500).json({ success: false, error: updateErr.message });
                res.json({ success: true, newSettlecredits: newSettle });
            });
        });
    };
    findUserAndUpdateSettle('students');
});

// 讯飞星火大模型 API 转发接口
const SPARK_API_URL = 'https://spark-api-open.xf-yun.com/v1/chat/completions';
const SPARK_API_KEY = 'rukgkmIXbHUNYNzcHNOx:KRBLtRlnMVqmueGIgOvV'; // 建议用环境变量存储

app.post('/api/spark', async (req, res) => {
    try {
        let { messages, model = "lite", stream = false, ...rest } = req.body;
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: 'messages 参数无效' });
        }
        model = "lite";
        const body = {
            model,
            messages,
            stream,
            ...rest
        };
        if (stream) {
            const response = await axios({
                method: 'post',
                url: SPARK_API_URL,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${SPARK_API_KEY}`
                },
                data: body,
                responseType: 'stream',
                timeout: 30000
            });
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.flushHeaders();
            response.data.on('data', chunk => {
                res.write(chunk);
            });
            response.data.on('end', () => {
                res.end();
            });
            response.data.on('error', err => {
                res.end();
            });
        } else {
            const response = await axios.post(
                SPARK_API_URL,
                body,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${SPARK_API_KEY}`
                    },
                    timeout: 15000
                }
            );
            res.json(response.data);
        }
    } catch (err) {
        if (err.response && err.response.data) {
            res.status(err.response.status).json(err.response.data);
        } else {
            res.status(500).json({ error: err.message || 'Spark API请求失败' });
        }
    }
});

app.get('/api/youdao-meaning', async (req, res) => {
    const word = String(req.query.word || '').trim();
    if (!word) {
        return res.status(400).json({ success: false, error: '缺少单词参数' });
    }

    const normalizeText = (text) => String(text || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const pushUnique = (list, seen, text) => {
        const normalized = normalizeText(text);
        if (!normalized) return;
        if (seen.has(normalized)) return;
        seen.add(normalized);
        list.push(normalized);
    };

    try {
        const response = await axios.get('https://dict.youdao.com/jsonapi', {
            params: { q: word },
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json,text/plain,*/*'
            }
        });

        const payload = response.data || {};
        const meanings = [];
        const seen = new Set();
        const normalizedWord = word.toLowerCase();

        const ecWord = payload?.ec?.word?.[0];
        if (Array.isArray(ecWord?.trs)) {
            ecWord.trs.forEach(item => {
                pushUnique(meanings, seen, item?.tran);
            });
        }

        const expandWord = payload?.expand_ec?.word?.[0];
        if (Array.isArray(expandWord?.transList)) {
            expandWord.transList.forEach(item => {
                pushUnique(meanings, seen, item?.trans);
            });
        }

        if (Array.isArray(payload?.individual?.trs)) {
            payload.individual.trs.forEach(item => {
                pushUnique(meanings, seen, item?.tran);
            });
        }

        if (Array.isArray(payload?.phrs?.phrs)) {
            const exactPhrase = payload.phrs.phrs.find(item => normalizeText(item?.headword).toLowerCase() === normalizedWord);
            if (exactPhrase) {
                pushUnique(meanings, seen, exactPhrase.translation);
            }
        }

        const firstWebTranslation = payload?.web_trans?.['web-translation']?.[0];
        if (Array.isArray(firstWebTranslation?.trans)) {
            firstWebTranslation.trans.forEach(item => {
                pushUnique(meanings, seen, item?.value);
            });
        }

        const firstMeaning = meanings[0] || '';
        res.json({ success: true, word, meaning: firstMeaning, meanings });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message || '有道释义获取失败', word, meaning: '', meanings: [] });
    }
});

// 新建班级接口
app.post('/api/class/create', (req, res) => {
    const { name, code, teacher_username } = req.body;
    if (!name || !code || !teacher_username) {
        return res.status(400).json({ error: '缺少参数' });
    }
    db.run(
        `INSERT INTO class (name, code, teacher_username) VALUES (?, ?, ?)`,
        [name, code, teacher_username],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, class_id: this.lastID });
        }
    );
});

// 修改班级名称
app.post('/api/class/update', (req, res) => {
    const { id, name } = req.body;
    if (!id || !name) return res.status(400).json({ error: '缺少参数' });
    db.run(`UPDATE class SET name=? WHERE id=?`, [name, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// 删除班级
app.post('/api/class/delete', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: '缺少参数' });
    db.run(`DELETE FROM class WHERE id=?`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        // 同时删除关联学生
        db.run(`DELETE FROM class_student WHERE class_id=?`, [id], function(err2) {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ success: true });
        });
    });
});

// 获取所有班级及其老师
app.get('/api/class/list', (req, res) => {
    db.all(`SELECT * FROM class`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 获取某班级的学生列表（返回对象数组，包含用户名和可扩展信息）
app.get('/api/class/students', (req, res) => {
    const { class_id } = req.query;
    if (!class_id) return res.status(400).json({ error: '缺少class_id参数' });
    db.all(
        `SELECT student_username as username FROM class_student WHERE class_id=?`,
        [class_id],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows); // [{username:...}, ...]
        }
    );
});

// 学生通过班级码加入班级
app.post('/api/class/join', (req, res) => {
    const { username, code } = req.body;
    if (!username || !code) return res.status(400).json({ error: '缺少参数' });
    db.get(`SELECT id FROM class WHERE code=?`, [code], (err, cls) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!cls) return res.status(404).json({ error: '班级码不存在' });
        // 检查是否已加入
        db.get(`SELECT id FROM class_student WHERE class_id=? AND student_username=?`, [cls.id, username], (err2, row) => {
            if (err2) return res.status(500).json({ error: err2.message });
            if (row) {
                // 已加入直接返回，但也要返回任务分配情况
                assignExistingTasksToStudent(cls.id, username, (assignErr, assignedCount) => {
                    if (assignErr) return res.status(500).json({ error: assignErr.message || assignErr });
                    res.json({ success: true, class_id: cls.id, assigned_tasks: assignedCount });
                });
                return;
            }
            db.run(
                `INSERT INTO class_student (class_id, student_username) VALUES (?, ?)`,
                [cls.id, username],
                function(err3) {
                    if (err3) return res.status(500).json({ error: err3.message });
                    // 新增：自动分配该班级已有任务
                    assignExistingTasksToStudent(cls.id, username, (assignErr, assignedCount) => {
                        if (assignErr) return res.status(500).json({ error: assignErr.message || assignErr });
                        res.json({ success: true, class_id: cls.id, assigned_tasks: assignedCount });
                    });
                }
            );
        });
    });
});

// 新增：为新加入班级的学生分配该班级所有未过期的任务
function assignExistingTasksToStudent(class_id, username, cb) {
    // 1. 查询该班级所有未过期的任务ID
    const today = new Date().toISOString().slice(0, 10);
    db.all(
        `SELECT t.id as task_id, t.deadline
         FROM task t
         JOIN task_assignment ta ON t.id = ta.task_id
         WHERE ta.class_id = ? AND (t.deadline IS NULL OR t.deadline >= ?)
         GROUP BY t.id`,
        [class_id, today],
        (err, rows) => {
            if (err) return cb && cb(err);
            if (!rows || rows.length === 0) return cb && cb(null, 0);
            // 2. 查询该学生已分配的任务ID
            db.all(
                `SELECT task_id FROM task_assignment WHERE class_id = ? AND student_username = ?`,
                [class_id, username],
                (err2, assignedRows) => {
                    if (err2) return cb && cb(err2);
                    const assignedTaskIds = new Set((assignedRows || []).map(r => r.task_id));
                    // 3. 过滤出未分配的任务
                    const toAssign = rows.filter(r => !assignedTaskIds.has(r.task_id));
                    if (toAssign.length === 0) return cb && cb(null, 0);
                    // 4. 批量插入
                    const now = new Date().toISOString();
                    let pending = toAssign.length, errorFlag = false;
                    toAssign.forEach(r => {
                        db.run(
                            `INSERT INTO task_assignment (task_id, student_username, class_id, assigned_at)
                             VALUES (?, ?, ?, ?)`,
                            [r.task_id, username, class_id, now],
                            function(err3) {
                                if (err3 && !errorFlag) {
                                    errorFlag = true;
                                    return cb && cb(err3);
                                }
                                if (--pending === 0 && !errorFlag) {
                                    cb && cb(null, toAssign.length);
                                }
                            }
                        );
                    });
                }
            );
        }
    );
}

// 移除学生（仅从班级移除，不删除学生账号）
app.post('/api/class/student-remove', (req, res) => {
    const { username, class_id } = req.body;
    if (!username || !class_id) {
        return res.status(400).json({ error: '缺少参数' });
    }
    db.run(
        `DELETE FROM class_student WHERE class_id=? AND student_username=?`,
        [class_id, username],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// 新增：发布任务接口
app.post('/api/task/publish', (req, res) => {
    const { teacher_username, task_type, task_name, task_content, deadline, repeat_days, class_ids, task_audio } = req.body;
    if (!teacher_username || !task_type || !task_name || !task_content || !deadline || !Array.isArray(class_ids)) {
        return res.status(400).json({ error: '缺少必要参数' });
    }
    const now = new Date().toISOString();
    db.run(
        `INSERT INTO task (teacher_username, task_type, task_name, task_content, deadline, repeat_days, created_at, task_audio)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [teacher_username, task_type, task_name, task_content, deadline, repeat_days || 1, now, task_audio || ''],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            const task_id = this.lastID;
            let affected_students = 0;
            let pending = class_ids.length;
            
            if (pending === 0) {
                return res.json({ success: true, task_id, affected_students: 0 });
            }
            
            // 为每个班级的学生创建任务分配记录
            class_ids.forEach(class_id => {
                // 获取班级学生列表
                db.all(
                    `SELECT student_username FROM class_student WHERE class_id = ?`,
                    [class_id],
                    (err2, students) => {
                        if (err2) {
                            pending--;
                            if (pending === 0) {
                                res.json({ success: true, task_id, affected_students });
                            }
                            return;
                        }
                        
                        affected_students += students.length;
                        
                        // 为每个学生创建任务分配记录
                        students.forEach(student => {
                            db.run(
                                `INSERT INTO task_assignment (task_id, student_username, class_id, assigned_at) 
                                 VALUES (?, ?, ?, ?)`,
                                [task_id, student.student_username, class_id, now],
                                (err3) => {
                                    if (err3) console.error('创建任务分配记录失败:', err3);
                                }
                            );
                        });
                        
                        pending--;
                        if (pending === 0) {
                            res.json({ success: true, task_id, affected_students });
                        }
                    }
                );
            });
        }
    );
});

// 新增：获取老师发布的任务列表
app.get('/api/task/teacher-list', (req, res) => {
    const { teacher_username } = req.query;
    if (!teacher_username) {
        return res.status(400).json({ error: '缺少老师用户名' });
    }
    
    db.all(
        `SELECT t.*, 
                COUNT(DISTINCT ta.student_username) as student_count
         FROM task t
         LEFT JOIN task_assignment ta ON t.id = ta.task_id
         WHERE t.teacher_username = ?
         GROUP BY t.id
         ORDER BY t.created_at DESC`,
        [teacher_username],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// 新增：获取所有老师发布的任务（管理端汇总）
app.get('/api/task/all', (req, res) => {
    const sql = `SELECT t.*, 
                        COUNT(DISTINCT ta.student_username) as student_count
                 FROM task t
                 LEFT JOIN task_assignment ta ON t.id = ta.task_id
                 GROUP BY t.id
                 ORDER BY t.created_at DESC`;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// 新增：获取任务详情接口（用于编辑）
app.get('/api/task/detail', (req, res) => {
    const { id } = req.query;
    if (!id) {
        return res.status(400).json({ error: '缺少任务ID参数' });
    }
    
    // 获取任务基本信息
    db.get(
        `SELECT * FROM task WHERE id = ?`,
        [id],
        (err, task) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!task) return res.status(404).json({ error: '任务不存在' });
            
            // 获取任务分配的班级ID列表
            db.all(
                `SELECT DISTINCT class_id FROM task_assignment WHERE task_id = ?`,
                [id],
                (err2, assignments) => {
                    if (err2) return res.status(500).json({ error: err2.message });
                    
                    // 添加班级ID列表到任务信息中
                    task.class_ids = assignments.map(a => a.class_id);
                    
                    res.json(task);
                }
            );
        }
    );
});

// 新增：修改任务接口
app.post('/api/task/update', (req, res) => {
    const { task_id, teacher_username, task_type, task_name, task_content, deadline, repeat_days, class_ids, task_audio } = req.body;
    if (!task_id || !teacher_username || !task_type || !task_name || !task_content || !deadline || !Array.isArray(class_ids)) {
        return res.status(400).json({ error: '缺少必要参数' });
    }
    db.get(
        `SELECT id FROM task WHERE id = ? AND teacher_username = ?`,
        [task_id, teacher_username],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(403).json({ error: '无权修改此任务' });
            db.run(
                `UPDATE task SET task_type = ?, task_name = ?, task_content = ?, deadline = ?, repeat_days = ?, task_audio = ? WHERE id = ?`,
                [task_type, task_name, task_content, deadline, repeat_days || 1, task_audio || '', task_id],
                function(err2) {
                    if (err2) return res.status(500).json({ error: err2.message });
                    
                    // 删除旧的任务分配记录
                    db.run(
                        `DELETE FROM task_assignment WHERE task_id = ?`,
                        [task_id],
                        (err3) => {
                            if (err3) return res.status(500).json({ error: err3.message });
                            
                            // 重新创建任务分配记录
                            const now = new Date().toISOString();
                            let affected_students = 0;
                            let pending = class_ids.length;
                            
                            if (pending === 0) {
                                return res.json({ success: true, task_id, affected_students: 0 });
                            }
                            
                            // 为每个班级的学生创建任务分配记录
                            class_ids.forEach(class_id => {
                                // 获取班级学生列表
                                db.all(
                                    `SELECT student_username FROM class_student WHERE class_id = ?`,
                                    [class_id],
                                    (err4, students) => {
                                        if (err4) {
                                            pending--;
                                            if (pending === 0) {
                                                res.json({ success: true, task_id, affected_students });
                                            }
                                            return;
                                        }
                                        
                                        affected_students += students.length;
                                        
                                        // 为每个学生创建任务分配记录
                                        students.forEach(student => {
                                            db.run(
                                                `INSERT INTO task_assignment (task_id, student_username, class_id, assigned_at) 
                                                 VALUES (?, ?, ?, ?)`,
                                                [task_id, student.student_username, class_id, now],
                                                (err5) => {
                                                    if (err5) console.error('创建任务分配记录失败:', err5);
                                                }
                                            );
                                        });
                                        
                                        pending--;
                                        if (pending === 0) {
                                            res.json({ success: true, task_id, affected_students });
                                        }
                                    }
                                );
                            });
                        }
                    );
                }
            );
        }
    );
});

// 新增：删除任务接口（支持老师删除任务及其分配记录）
app.post('/api/task/delete', (req, res) => {
    const { task_id, teacher_username } = req.body;
    if (!task_id || !teacher_username) {
        return res.status(400).json({ success: false, error: '缺少参数' });
    }
    // 验证任务归属
    db.get(`SELECT id FROM task WHERE id = ? AND teacher_username = ?`, [task_id, teacher_username], (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!row) return res.status(403).json({ success: false, error: '无权删除此任务' });
        // 先删除分配记录，再删主表
        db.run(`DELETE FROM task_assignment WHERE task_id = ?`, [task_id], function(err2) {
            if (err2) return res.status(500).json({ success: false, error: err2.message });
            db.run(`DELETE FROM task WHERE id = ?`, [task_id], function(err3) {
                if (err3) return res.status(500).json({ success: false, error: err3.message });
                res.setHeader('Content-Type', 'application/json');
                res.json({ success: true });
            });
        });
    });
});

// 新增：删除已完成任务接口
app.post('/api/task/delete-completed', (req, res) => {
    const { task_id, teacher_username } = req.body;
    if (!task_id || !teacher_username) {
        return res.status(400).json({ success: false, error: '缺少参数' });
    }
    // 首先验证这个提交记录是否属于该老师发布的任务
    db.get(
        `SELECT sts.id, sts.task_id, t.teacher_username, sts.recording_files
         FROM student_task_submit sts
         JOIN task t ON sts.task_id = t.id
         WHERE sts.id = ? AND t.teacher_username = ?`,
        [task_id, teacher_username],
        (err, row) => {
            if (err) {
                return res.status(500).json({ success: false, error: err.message });
            }
            if (!row) {
                return res.status(403).json({ success: false, error: '无权删除此提交记录或记录不存在' });
            }
            // 删除录音文件
            if (row.recording_files) {
                let filenames = [];
                try {
                    const parsed = JSON.parse(row.recording_files);
                    if (Array.isArray(parsed)) filenames = parsed;
                } catch {}
                filenames.forEach(filename => {
                    if (filename && typeof filename === 'string') {
                        const filePath = path.join(audioSaveDir, filename);
                        fs.unlink(filePath, err => {
                            if (err && err.code !== 'ENOENT') {
                                console.warn('删除录音文件失败:', filePath, err.message);
                            }
                        });
                    }
                });
            }
            // 删除提交记录
            db.run(
                `DELETE FROM student_task_submit WHERE id = ?`,
                [task_id],
                function(err2) {
                    if (err2) {
                        return res.status(500).json({ success: false, error: err2.message });
                    }
                    res.setHeader('Content-Type', 'application/json');
                    res.json({ success: true });
                }
            );
        }
    );
});

// 新增：清除所有学生所有已完成的任务接口
app.post('/api/task-assignment/clear-all-submits', (req, res) => {
    db.run('DELETE FROM student_task_submit', function(err) {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
        res.setHeader('Content-Type', 'application/json');
        res.json({ success: true, deleted: this.changes });
    });
});

// 新增：数据库初始化时创建作业相关表
function initDatabase() {
    // ...existing table creation code...
    
    // 任务主表
    db.run(`CREATE TABLE IF NOT EXISTS task (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_username TEXT NOT NULL,
        task_type TEXT NOT NULL,
        task_name TEXT NOT NULL,
        task_content TEXT NOT NULL,
        deadline TEXT NOT NULL,
        repeat_days INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
    )`);

    // 兼容旧库：自动添加 task_audio 字段（只执行一次，不会重复报错）
    db.run(`ALTER TABLE task ADD COLUMN task_audio TEXT`, () => {});

    
    // 任务分配表
    db.run(`CREATE TABLE IF NOT EXISTS task_assignment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        student_username TEXT NOT NULL,
        class_id INTEGER NOT NULL,
        assigned_at TEXT NOT NULL,
        completed_at TEXT,
        completion_count INTEGER DEFAULT 0,
        last_completion_date TEXT,
        FOREIGN KEY (task_id) REFERENCES task(id),
        FOREIGN KEY (class_id) REFERENCES class(id)
    )`);
    
    // 班级表（已存在）
    db.run(`CREATE TABLE IF NOT EXISTS class (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        code TEXT UNIQUE NOT NULL,
        teacher_username TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // 班级学生关联表（已存在）
    db.run(`CREATE TABLE IF NOT EXISTS class_student (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL,
        student_username TEXT NOT NULL,
        joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (class_id) REFERENCES class(id),
        UNIQUE(class_id, student_username)
    )`);
}

// 启动时调用数据库初始化
initDatabase();

// 启动服务
//app.listen(PORT, () => {
//    console.log(`Server running at http://localhost:${PORT}/`);
//    
//    // 新增：初始化口语听力表
//    initOralListeningTable();
    
    // 新增：启动定时清零任务
//    scheduleOralListeningWeeklyClear();
//});

// 新增：定时清空终端显示内容（每6小时清空一次，可自行调整时间间隔）
setInterval(() => {
    console.clear();
    console.log(`[${new Date().toLocaleString()}] 控制台已自动清空。`);
}, 6 * 60 * 60 * 1000); // 6小时

// 年级积分统计配置：每个年级独立指明积分统计的训练记录前缀（支持多个前缀用数组）
const gradeCreditConfig = {
    "1A":   { wordrevPrefixes: ["wordRev1A_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev1A_Records"] },
    "1B":   { wordrevPrefixes: ["wordRev1B_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev1B_Records"] },
    "2A":   { wordrevPrefixes: ["wordRev2A_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev2A_Records"] },
    "2B":   { wordrevPrefixes: ["wordRev2B_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev2B_Records"] },
    "3A":   { wordrevPrefixes: ["wordRev3A_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev3A_Records"] },
    "3B":   { wordrevPrefixes: ["wordRev3B_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev3B_Records"] },
    "4A":   { wordrevPrefixes: ["wordRev4A_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev4A_Records"] },
    "4B":   { wordrevPrefixes: ["wordRev4B_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev4B_Records"] },
    "5A":   { wordrevPrefixes: ["wordRev5A_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev5A_Records"] },
    "5B":   { wordrevPrefixes: ["wordRev5B_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev5B_Records"] },
    "6A":   { wordrevPrefixes: ["wordRev6A_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev6A_Records"] },
    "6B":   { wordrevPrefixes: ["wordRev6B_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev6B_Records"] },
    "7A":   { wordrevPrefixes: ["wordRev7A_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev7A_Records"] },
    "7B":   { wordrevPrefixes: ["wordRev7B_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev7B_Records"] },
    "8A":   { wordrevPrefixes: ["wordRev8A_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev8A_Records"] },
    "8B":   { wordrevPrefixes: ["wordRev8B_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev8B_Records"] },
    "9A":   { wordrevPrefixes: ["wordRev9A_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev9A_Records"] },
    "9B":   { wordrevPrefixes: ["wordRev9B_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev9B_Records"] },
    "10A":  { wordrevPrefixes: ["wordRev10A_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev10A_Records"] },
    "10B":  { wordrevPrefixes: ["wordRev10B_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev10B_Records"] },
    "11A":  { wordrevPrefixes: ["wordRev11A_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev11A_Records"] },
    "11B":  { wordrevPrefixes: ["wordRev11B_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev11B_Records"] },
    "12A":  { wordrevPrefixes: ["wordRev12A_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev12A_Records"] },
    "12B":  { wordrevPrefixes: ["wordRev12B_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRev12B_Records"] },
    "camb1A": { wordrevPrefixes: ["wordRevcamb1A_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRevcamb1A_Records"] },
    "camb1B": { wordrevPrefixes: ["wordRevcamb1B_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRevcamb1B_Records"] },
    "camb2A": { wordrevPrefixes: ["wordRevcamb2A_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRevcamb2A_Records"] },
    "camb2B": { wordrevPrefixes: ["wordRevcamb2B_Records", "wordRevcommon_Records"], kingrevPrefixes: ["kingRevcamb2B_Records"] }
    // 新增年级只需在此处添加即可
};

// ====== vocabustu.db 词汇掌握功能实现（拼音表名+映射表） ======
const vocabDbPath = path.join(__dirname, 'vocabustu.db');
const vocabDb = new sqlite3.Database(vocabDbPath);

// 新增：映射表，记录中文姓名与拼音表名的对应关系
vocabDb.serialize(() => {
    vocabDb.run(`CREATE TABLE IF NOT EXISTS vocabustu_user_map (
        username TEXT PRIMARY KEY,
        table_name TEXT UNIQUE
    )`);
});

// 工具：将中文姓名转为拼音（全小写、无空格、无声调）
function getPinyinBase(name) {
    if (!name) return '';
    // 只保留汉字，去除空格
    const arr = pinyin(name, { style: pinyin.STYLE_NORMAL });
    return arr.flat().join('').toLowerCase();
}

// 工具：为学生分配唯一拼音表名（如 zhangqiang1、zhangqiang2）
function getOrCreateVocabTableName(username, cb) {
    if (!username) return cb('用户名为空');
    // 先查映射表
    vocabDb.get(`SELECT table_name FROM vocabustu_user_map WHERE username=?`, [username], (err, row) => {
        if (err) return cb(err);
        if (row && row.table_name) return cb(null, row.table_name);
        // 没有映射，自动分配
        const base = getPinyinBase(username);
        if (!base) return cb('无法生成拼音');
        // 查找已存在的以base开头的表名
        vocabDb.all(`SELECT table_name FROM vocabustu_user_map WHERE table_name LIKE ?`, [base + '%'], (err2, rows) => {
            if (err2) return cb(err2);
            let maxNum = 0;
            rows.forEach(r => {
                const m = r.table_name.match(new RegExp('^' + base + '(\\d+)$'));
                if (m) {
                    const n = parseInt(m[1], 10);
                    if (n > maxNum) maxNum = n;
                }
            });
            const newNum = maxNum + 1;
            const tableName = base + newNum;
            // 写入映射表
            vocabDb.run(`INSERT INTO vocabustu_user_map (username, table_name) VALUES (?, ?)`, [username, tableName], function(err3) {
                if (err3) return cb(err3);
                cb(null, tableName);
            });
        });
    });
}

// 工具：确保拼音表存在
function ensureVocabTable(username, cb) {
    getOrCreateVocabTableName(username, (err, tableName) => {
        if (err) return cb && cb(err);
        const safeTable = '"' + tableName.replace(/"/g, '""') + '"';
        vocabDb.run(
            `CREATE TABLE IF NOT EXISTS ${safeTable} (
                word TEXT PRIMARY KEY,
                mastered_at TEXT,
                page_title TEXT,
                unit_info TEXT
            )`,
            cb
        );
    });
}

// 工具：批量插入掌握单词
function insertMasteredWords(username, words, masteredAt, pageTitle, unitInfo, cb) {
    if (!Array.isArray(words) || words.length === 0) return cb && cb();
    getOrCreateVocabTableName(username, (err, tableName) => {
        if (err) return cb && cb(err);
        ensureVocabTable(username, () => {
            const safeTable = '"' + tableName.replace(/"/g, '""') + '"';
            const stmt = vocabDb.prepare(
                `INSERT OR REPLACE INTO ${safeTable} (word, mastered_at, page_title, unit_info) VALUES (?, ?, ?, ?)`
            );
            words.forEach(word => {
                stmt.run(word, masteredAt, pageTitle, unitInfo);
            });
            stmt.finalize(cb);
        });
    });
}

// 工具：获取词汇量
function getVocabCount(username, cb) {
    getOrCreateVocabTableName(username, (err, tableName) => {
        if (err) return cb && cb(err, 0);
        ensureVocabTable(username, () => {
            const safeTable = '"' + tableName.replace(/"/g, '""') + '"';
            vocabDb.get(`SELECT COUNT(*) as cnt FROM ${safeTable}`, (err2, row) => {
                cb && cb(err2, row ? row.cnt : 0);
            });
        });
    });
}

// 工具：获取词汇明细
function getVocabList(username, cb) {
    getOrCreateVocabTableName(username, (err, tableName) => {
        if (err) return cb && cb(err, []);
        ensureVocabTable(username, () => {
            const safeTable = '"' + tableName.replace(/"/g, '""') + '"';
            vocabDb.all(`SELECT * FROM ${safeTable} ORDER BY mastered_at DESC`, (err2, rows) => {
                cb && cb(err2, rows || []);
            });
        });
    });
}

// 清理过期单词（10950天前）
function cleanExpiredVocabulary() {
    console.log('开始清理过期单词...');
    // 获取10950天前的日期
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() - 10950); // 30年 = 10950天
    const expiryDateStr = expiryDate.toISOString();
    
    // 获取所有用户表
    vocabDb.all(`SELECT name FROM sqlite_master WHERE type='table'`, [], (err, tables) => {
        if (err) {
            console.error('获取表列表失败:', err.message);
            return;
        }
        
        let cleanedCount = 0;
        let pendingTables = tables.length;
        
        if (pendingTables === 0) {
            console.log('没有找到用户表，清理完成');
            return;
        }
        
        tables.forEach(table => {
            const tableName = table.name;
            // 安全处理表名
            const safeTable = '"' + tableName.replace(/"/g, '""') + '"';
            
            // 删除超过10950天的单词
            vocabDb.run(
                `DELETE FROM ${safeTable} WHERE mastered_at < ?`,
                [expiryDateStr],
                function(err) {
                    if (err) {
                        console.error(`清理表 ${tableName} 中的过期单词失败:`, err.message);
                    } else {
                        cleanedCount += this.changes;
                        console.log(`从表 ${tableName} 中清理了 ${this.changes} 个过期单词`);
                    }
                    
                    if (--pendingTables === 0) {
                        console.log(`词汇掌握库清理完成，共清理 ${cleanedCount} 个过期单词`);
                    }
                }
            );
        });
    });
}

// 设置定时器，每天凌晨执行一次词汇清理
function scheduleVocabularyCleanup() {
    // 获取下一个凌晨的时间
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setDate(now.getDate() + 1);
    nextMidnight.setHours(0, 0, 0, 0);
    
    const msUntilMidnight = nextMidnight.getTime() - now.getTime();
    
    // 设置定时器，在下一个凌晨执行清理，之后每24小时执行一次
    setTimeout(() => {
        cleanExpiredVocabulary();
        setInterval(cleanExpiredVocabulary, 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
    
    console.log(`词汇掌握过期清理已设置，将在 ${new Date(now.getTime() + msUntilMidnight).toLocaleString()} 首次执行`);
}

// 启动定时清理任务
scheduleVocabularyCleanup();

// 服务器启动时执行一次清理（可选）- 注释掉，正常情况下定时清理已足够
// cleanExpiredVocabulary();

// ====== 修改大师赛记录上传接口，追加词汇掌握写入 ======
// 重新定义 /api/uploadRecords 接口，包含原有逻辑和词汇掌握写入
app.post('/api/uploadRecords', (req, res) => {
    const { username, type, unit, records } = req.body;
    if (!username || !type || !unit || !Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ error: '参数不完整或格式错误' });
    }
    const r = records[0];
    if (!r || typeof r.dateTime !== 'string' || typeof r.duration !== 'string' || typeof r.score !== 'number' || typeof r.totalWords !== 'number') {
        return res.status(400).json({ error: '记录数据格式无效' });
    }
    
    // 原有逻辑：保存记录到数据库
    const stmt = db.prepare(`INSERT INTO records (username, type, unit, dateTime, duration, score, totalWords, unitsString) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(username, type, unit, r.dateTime, r.duration, r.score, r.totalWords, r.unitsString || '', function(err) {
        if (err) {
            stmt.finalize();
            return res.status(500).json({ error: '数据库插入失败' });
        }
        stmt.finalize();
        
        // 新增逻辑：只在大师赛(masterrev)且100%正确率时处理词汇掌握
        try {
            if (type === 'masterrev') {
                // 支持前端传 correctPercent 或 score/totalWords
                const correctPercent = typeof r.correctPercent === 'number'
                    ? r.correctPercent
                    : (typeof r.score === 'number' && typeof r.totalWords === 'number' && r.totalWords > 0
                        ? (r.score / r.totalWords) * 100 : 0);
                if (correctPercent === 100) {
                    // 推荐前端上传 words: [单词数组]，否则无法自动获取
                    const words = Array.isArray(r.words) ? r.words : [];
                    // 页面title和单元信息
                    const pageTitle = r.pageTitle || unit || '';
                    const unitInfo = r.unitInfo || unit || '';
                    const masteredAt = r.dateTime || new Date().toISOString();
                    if (words.length > 0) {
                        insertMasteredWords(username, words, masteredAt, pageTitle, unitInfo, () => {});
                    }
                }
            }
        } catch (e) {
            // 忽略异常，保证主流程不受影响
            console.error('词汇掌握写入失败:', e);
        }
        
        res.json({ success: true, id: this.lastID });
    });
});

// ====== 词王榜功能开始 ======
// ====== 新增API：查询学生词汇量 ======
app.get('/api/vocabustu/count', (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: '缺少用户名' });
    getVocabCount(username, (err, cnt) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ count: cnt });
    });
});

// ====== 新增API：查询学生词汇明细 ======
app.get('/api/vocabustu/list', (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: '缺少用户名' });
    getVocabList(username, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// ===== 新增：后端返回词王榜前30名，减少前端请求量 =====
// 替换原有的 getVocabCountAsync，实现返回“合并后的词汇量”
// 合并逻辑：engword_stuword 中的 mastered（maxRound >= 7） + vocabustu 中的词，去重后计数
function getVocabCountAsync(username) {
    return new Promise(resolve => {
        try {
            // 1) 从 engword_stuword 读取该用户的记录
            db.all(`SELECT word, rounds FROM engword_stuword WHERE username = ?`, [username], (err, rows) => {
                if (err) {
                    console.error(`[vocab] 获取 engword_stuword ${username} 失败:`, err && err.message ? err.message : err);
                    return resolve(0);
                }

                const engMastered = new Set();
                (rows || []).forEach(r => {
                    try {
                        const rounds = JSON.parse(r.rounds || '[]');
                        const maxRound = rounds.reduce((m, it) => Math.max(m, Number(it.round) || 0), 0);
                        if (maxRound >= 7 && r.word) engMastered.add(String(r.word).trim());
                    } catch (e) {
                        // 忽略解析错误
                    }
                });

                // 2) 从 vocabustu 获取该用户的已掌握词汇明细
                getVocabList(username, (err2, vocabRows) => {
                    if (err2) {
                        console.error(`[vocab] getVocabList ${username} 失败:`, err2 && err2.message ? err2.message : err2);
                        // 如果失败，则只返回 engMastered 的数量（或 0）
                        return resolve(engMastered.size || 0);
                    }

                    const vocabMastered = new Set();
                    (vocabRows || []).forEach(r => {
                        const w = r.word || r.word_text || r.vocab || r.wordName || r.wordName || '';
                        if (w) vocabMastered.add(String(w).trim());
                    });

                    // 3) 合并并去重：vocabMastered + engMastered 中不在 vocabMastered 的词
                    let newFromEngCount = 0;
                    engMastered.forEach(w => {
                        if (!vocabMastered.has(w)) newFromEngCount++;
                    });

                    const mergedCount = vocabMastered.size + newFromEngCount;
                    resolve(Number(mergedCount || 0));
                });
            });
        } catch (e) {
            console.error('[vocab] getVocabCountAsync 异常:', e);
            resolve(0);
        }
    });
}
// 服务器端复用的等级划分（与前端一致的简化版）
function getVocabLevelServer(vocabCount) {
    if (vocabCount >= 15000) return '专业8级及格';
    if (vocabCount >= 9500) return '专业4级及格';
    if (vocabCount >= 8200) return '大学6级及格';
    if (vocabCount >= 7000) return '碾压高考';
    if (vocabCount >= 6000) return '大学4级及格';
    if (vocabCount >= 4000) return '裸考PET';
    if (vocabCount >= 3500) return '高考及格';
    if (vocabCount >= 3000) return '表达自如';
    if (vocabCount >= 2800) return '听力进阶';
    if (vocabCount >= 2500) return '字幕自由';
    if (vocabCount >= 2200) return '中考满分';
    if (vocabCount >= 2000) return '日常畅谈';
    if (vocabCount >= 1900) return '裸考KET';
    if (vocabCount >= 1800) return '中考合格';
    if (vocabCount >= 1700) return '阅读起步';
    if (vocabCount >= 1600) return '旅游通关';
    if (vocabCount >= 1500) return '故事解码';
    if (vocabCount >= 1400) return '剑桥三级';
    if (vocabCount >= 1300) return '畅聊日常';
    if (vocabCount >= 1200) return '进重点班';
    if (vocabCount >= 1100) return '影剧初窥';
    if (vocabCount >= 1000) return '小学毕业';
    if (vocabCount >= 900) return '剑桥二级';
    if (vocabCount >= 800) return '社交启蒙';
    if (vocabCount >= 700) return '点单无忧';
    if (vocabCount >= 600) return '拼读达人';
    if (vocabCount >= 500) return '剑桥一级';
    if (vocabCount >= 400) return '寒暄高手';
    if (vocabCount >= 300) return '餐厅幸存';
    if (vocabCount >= 200) return '单词萌新';
    if (vocabCount >= 100) return '学舌宝宝';
    return '英语小白';
}

app.get('/api/vocab-ranking-top', async (req, res) => {
    try {
        // 获取永久名单
        const permanent = await new Promise((resolve, reject) => {
            db.all(`SELECT username, grade_stu FROM students`, [], (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            });
        });
        // 获取注册且 status=1 的名单（可能包括过期，我们再校验）
        const regActive = await new Promise((resolve, reject) => {
            db.all(`SELECT username, grantTime, grade_stu FROM registered_stu WHERE status=1`, [], (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            });
        });

        const now = Date.now();
        const usersMap = new Map();

        // 加入永久名单
        permanent.forEach(r => {
            if (!r || !r.username) return;
            usersMap.set(r.username, { username: r.username, grade: r.grade_stu || '', type: 'permanent' });
        });

        // 加入注册且仍在有效期的（按 grantTime + 1 month 判断）
        regActive.forEach(r => {
            if (!r || !r.username) return;
            if (!r.grantTime) return;
            const grant = new Date(r.grantTime);
            const expire = new Date(grant);
            expire.setMonth(grant.getMonth() + 1);
            if (now < expire.getTime()) {
                if (!usersMap.has(r.username)) {
                    usersMap.set(r.username, { username: r.username, grade: r.grade_stu || '', type: 'registered' });
                }
            }
        });

        const users = Array.from(usersMap.values());

        // 并发获取词汇量（可能较多，但限制后端返回前30）
        const promises = users.map(async u => {
            const cnt = await getVocabCountAsync(u.username);
            return {
                username: u.username,
                vocabCount: Number(cnt || 0),
                level: getVocabLevelServer(Number(cnt || 0)),
                grade: u.grade || '',
                type: u.type
            };
        });

        const all = await Promise.all(promises);

        // 排序并返回前30
        all.sort((a, b) => b.vocabCount - a.vocabCount || a.username.localeCompare(b.username));
        const top30 = all.slice(0, 30);

        res.json({ success: true, top: top30 });
    } catch (err) {
        console.error('获取后端词王榜失败:', err);
        res.status(500).json({ success: false, error: err.message || '内部错误' });
    }
});
// ====== 词王榜功能结束 ======

// 新增：查询学生已加入的所有班级（用于学生端作业平台入口）
app.get('/api/class/student-classes', (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: '缺少用户名参数' });
    db.all(
        `SELECT c.id, c.name, c.code, c.teacher_username
         FROM class_student cs
         JOIN class c ON cs.class_id = c.id
         WHERE cs.student_username = ?`,
        [username],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// 新增：查询学生收到的所有任务及任务详情（用于 student.html）
app.get('/api/task-assignment/list', (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: '缺少用户名' });
    db.all(
        `SELECT ta.id as assignment_id, ta.task_id, ta.class_id, ta.assigned_at, ta.completed_at, ta.completion_count, ta.last_completion_date, ta.today_completion_count, ta.last_weekday_completion_date,
                t.task_type, t.task_name, t.task_content, t.deadline, t.repeat_days, t.teacher_username, t.task_audio
         FROM task_assignment ta
         JOIN task t ON ta.task_id = t.id
         WHERE ta.student_username = ?
         ORDER BY t.deadline DESC, t.created_at DESC`,
        [username],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// 新增：查询特定班级的任务ID列表
app.get('/api/task-assignment/class-tasks', (req, res) => {
    const { class_id } = req.query;
    if (!class_id) {
        return res.status(400).json({ error: '缺少班级ID参数' });
    }
    
    db.all(
        `SELECT DISTINCT task_id FROM task_assignment WHERE class_id = ?`,
        [class_id],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const taskIds = (rows || []).map(row => row.task_id);
            res.json(taskIds);
        }
    );
});

// ====== 新增：学生作业提交表和接口 ======

// 1. 数据库表初始化
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS student_task_submit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        assignment_id INTEGER NOT NULL,
        task_id INTEGER NOT NULL,
        class_id INTEGER,
        task_type TEXT,
        task_name TEXT,
        task_content TEXT,
        deadline TEXT,
        repeat_days INTEGER,
        answer_phase TEXT,
        answer_type TEXT,
        sentences TEXT,         -- JSON string
        user_answers TEXT,      -- JSON string
        ai_judges TEXT,         -- JSON string
        ai_comments TEXT,       -- JSON string
        ai_report TEXT,         -- HTML or markdown
        submit_time TEXT,
        recording_files TEXT     -- 录音文件字段
    )`);
});

// 新增：为 student_task_submit 表添加 recording_files 字段（兼容旧数据库）
db.serialize(() => {
    db.run(`ALTER TABLE student_task_submit ADD COLUMN recording_files TEXT`, () => {});
});

// Migration: remove UNIQUE index on (username, assignment_id, answer_phase) if it exists
db.serialize(() => {
    try {
        db.all("PRAGMA index_list('student_task_submit')", (err, indexes) => {
            if (err || !indexes || !indexes.length) return;
            const candidates = indexes.filter(ix => ix.unique);
            if (!candidates || !candidates.length) return;
            let found = null;
            let pending = candidates.length;
            candidates.forEach(ix => {
                db.all(`PRAGMA index_info(${ix.name})`, (e2, idxCols) => {
                    pending--;
                    if (!e2 && idxCols) {
                        const cols = idxCols.map(c => c.name).join(',');
                        if (cols.replace(/\s/g, '') === 'username,assignment_id,answer_phase') {
                            found = ix.name;
                        }
                    }
                    if (pending === 0 && found) {
                        console.log('Removing unique index', found, 'from student_task_submit');
                        try {
                            db.serialize(() => {
                                db.run('BEGIN TRANSACTION');
                                db.run(`CREATE TABLE IF NOT EXISTS student_task_submit_new (
                                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                                    username TEXT NOT NULL,
                                    assignment_id INTEGER NOT NULL,
                                    task_id INTEGER NOT NULL,
                                    class_id INTEGER,
                                    task_type TEXT,
                                    task_name TEXT,
                                    task_content TEXT,
                                    deadline TEXT,
                                    repeat_days INTEGER,
                                    answer_phase TEXT,
                                    answer_type TEXT,
                                    sentences TEXT,
                                    user_answers TEXT,
                                    ai_judges TEXT,
                                    ai_comments TEXT,
                                    ai_report TEXT,
                                    submit_time TEXT,
                                    recording_files TEXT
                                )`);
                                db.run(`INSERT INTO student_task_submit_new (
                                    id, username, assignment_id, task_id, class_id,
                                    task_type, task_name, task_content, deadline, repeat_days,
                                    answer_phase, answer_type, sentences, user_answers,
                                    ai_judges, ai_comments, ai_report, submit_time, recording_files
                                ) SELECT id, username, assignment_id, task_id, class_id,
                                    task_type, task_name, task_content, deadline, repeat_days,
                                    answer_phase, answer_type, sentences, user_answers,
                                    ai_judges, ai_comments, ai_report, submit_time, recording_files
                                    FROM student_task_submit`);
                                db.run(`DROP TABLE student_task_submit`);
                                db.run(`ALTER TABLE student_task_submit_new RENAME TO student_task_submit`);
                                db.run('COMMIT');
                                console.log('Migration complete: removed unique constraint on student_task_submit');
                            });
                        } catch (mErr) {
                            console.error('Migration failed:', mErr);
                        }
                    }
                });
            });
        });
    } catch (ex) {
        console.warn('Error checking student_task_submit indexes for migration:', ex);
    }
});

// 新增：为 task_assignment 表添加每日完成计数和上次工作日完成日期字段（兼容旧数据库）
db.serialize(() => {
    db.run(`ALTER TABLE task_assignment ADD COLUMN today_completion_count INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE task_assignment ADD COLUMN last_weekday_completion_date TEXT`, () => {});
});

// 2. 学生提交作业接口
app.post('/api/task-assignment/submit', (req, res) => {
    const {
        username, assignment_id, task_id, class_id,
        task_type, task_name, task_content, deadline, repeat_days,
        answer_phase, answer_type,
        sentences, user_answers, ai_judges, ai_comments, ai_report, submit_time,
        audio_filenames // 新增：音频文件名数组
    } = req.body;

    if (!username || !assignment_id || !task_id) {
        return res.status(400).json({ error: '缺少必要参数' });
    }

    // 只存储音频文件名数组到 recording_files 字段
    const recording_files = Array.isArray(audio_filenames) ? audio_filenames : [];

    db.run(
        `INSERT INTO student_task_submit (
            username, assignment_id, task_id, class_id,
            task_type, task_name, task_content, deadline, repeat_days,
            answer_phase, answer_type,
            sentences, user_answers, ai_judges, ai_comments, ai_report, submit_time,
            recording_files
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            username, assignment_id, task_id, class_id,
            task_type, task_name, task_content, deadline, repeat_days,
            answer_phase, answer_type,
            JSON.stringify(sentences || []),
            JSON.stringify(user_answers || []),
            JSON.stringify(ai_judges || []),
            JSON.stringify(ai_comments || []),
            ai_report || '',
            submit_time || new Date().toISOString(),
            JSON.stringify(recording_files)
        ],
        function (err) {
            if (err) {
                console.error('提交作业失败:', err);
                return res.status(500).json({ error: '提交失败' });
            }
            res.json({ success: true, id: this.lastID });
        }
    );
});

// 3. 查询学生作业提交记录（可供老师/学生端调用）
app.get('/api/task-assignment/submit-list', (req, res) => {
    const { username, assignment_id } = req.query;
    let sql = `SELECT * FROM student_task_submit WHERE 1=1`;
    const params = [];
    if (username) {
        sql += ` AND username = ?`;
        params.push(username);
    }
    if (assignment_id) {
        sql += ` AND assignment_id = ?`;
        params.push(assignment_id);
    }
    sql += ` ORDER BY submit_time DESC`;
    db.all(sql, params, (err, rows) => {
        if (err) {
            console.error('查询提交记录失败:', err);
            return res.status(500).json({ error: '查询失败' });
        }
        // 解析JSON字段并处理录音文件
        const processedRows = rows.map(row => {
            const processed = { ...row };
            processed.sentences = safeParseJson(row.sentences);
            processed.user_answers = safeParseJson(row.user_answers);
            processed.ai_judges = safeParseJson(row.ai_judges);
            processed.ai_comments = safeParseJson(row.ai_comments);
            
            // 新增：解析录音文件数据
            if (row.recording_files) {
                try {
                    processed.recording_files = JSON.parse(row.recording_files);
                } catch {
                    processed.recording_files = [];
                }
            } else {
                processed.recording_files = [];
            }
            
            return processed;
        });
        res.json(processedRows);
    });
});

function safeParseJson(str) {
    try {
        return JSON.parse(str || '[]');
    } catch {
        return [];
    }
}

// 新增：更新任务分配的最后完成日期接口
app.post('/api/task-assignment/update-completion', (req, res) => {
    const { assignment_id, username, completion_date } = req.body;
    if (!assignment_id || !username || !completion_date) {
        return res.status(400).json({ error: '缺少必要参数' });
    }

    // 判断 completion_date 是否为工作日（周一至周五）
    const dt = new Date(completion_date);
    const dow = dt.getDay();
    const isWeekday = dow >= 1 && dow <= 5;
    
    db.run(
        `UPDATE task_assignment 
         SET last_completion_date = ?,
             completion_count = completion_count + 1,
             today_completion_count = CASE WHEN last_completion_date = ? THEN today_completion_count + 1 ELSE 1 END,
             last_weekday_completion_date = CASE WHEN CAST(? AS INTEGER) = 1 THEN ? ELSE last_weekday_completion_date END
         WHERE id = ? AND student_username = ?`,
        [completion_date, completion_date, isWeekday ? 1 : 0, completion_date, assignment_id, username],
        function(err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: '任务分配记录不存在' });
            }
            res.json({ success: true });
        }
    );
});

// ====== 新增API：导出vocabustu.db所有内容 ======
app.get('/api/export-all-vocabustu', (req, res) => {
    vocabDb.all(`SELECT username, table_name FROM vocabustu_user_map`, [], (err, users) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!Array.isArray(users) || users.length === 0) return res.json([]);
        let pending = users.length;
        const result = [];
        users.forEach(u => {
            const safeTable = '"' + u.table_name.replace(/"/g, '""') + '"';
            vocabDb.all(`SELECT * FROM ${safeTable}`, [], (err2, words) => {
                result.push({
                    username: u.username,
                    words: words || []
                });
                if (--pending === 0) {
                    res.setHeader('Content-Type', 'application/json');
                    res.json(result);
                }
            });
        });
    });
});

// 新增：静态开放 audiosave 文件夹
const audioSaveDir = path.join(__dirname, 'homework', 'audiosave');
if (!fs.existsSync(audioSaveDir)) {
    fs.mkdirSync(audioSaveDir, { recursive: true });
}
app.use('/homework/audiosave', express.static(audioSaveDir));

// 新增：音频上传接口
const audioStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, audioSaveDir);
    },
    filename: function (req, file, cb) {
        // 保持前端传来的文件名（已唯一化）
        cb(null, file.originalname);
    }
});
const audioUpload = multer({ storage: audioStorage });

app.post('/api/audio-upload', audioUpload.single('audio'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: '未收到音频文件' });
    }
    // 返回文件名即可
    res.json({ success: true, filename: req.file.filename });
});

// 新增：静态开放 audio_temp 文件夹
const audioTempDir = path.join(__dirname, 'homework', 'audio_temp');
if (!fs.existsSync(audioTempDir)) {
    fs.mkdirSync(audioTempDir, { recursive: true });
}
app.use('/homework/audio_temp', express.static(audioTempDir));

// 新增：音频临时上传接口（保存到 audio_temp 文件夹）
const tempAudioStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, audioTempDir);
    },
    filename: function (req, file, cb) {
        // 生成唯一文件名
        const ext = path.extname(file.originalname) || '.wav';
        const filename = `temp_${Date.now()}_${Math.floor(Math.random() * 10000)}${ext}`;
        cb(null, filename);
    }
});
const tempAudioUpload = multer({ storage: tempAudioStorage });

app.post('/api/audio-temp-upload', tempAudioUpload.single('audio'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: '未收到音频文件' });
    }
    res.json({ success: true, filename: req.file.filename });
});

        const APISecret = "MGY1YjNhM2U1ZWM4ZWJmMTcwODE0NmEx";
        const APIKey = "d825216a1f5d095c7a53c6380f210a64";
        const HOST = 'iat-api.xfyun.cn';
        const BASE_URL = 'wss://iat-api.xfyun.cn/v2/iat';

        const crypto = require('crypto');

// 新增：将 audio_temp 文件保存到 audiosave
app.post('/api/audio-save', (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ success: false, error: '缺少文件名' });
    const src = path.join(__dirname, 'homework', 'audio_temp', filename);
    const dest = path.join(__dirname, 'homework', 'audiosave', filename);
    fs.copyFile(src, dest, (err) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true });
    });
});

app.get('/api/xfyun-signurl', (req, res) => {
        const date = new Date().toUTCString();
        const requestLine = 'GET /v2/iat HTTP/1.1';
        const signatureOrigin = `host: ${HOST}\ndate: ${date}\n${requestLine}`;
        const hmac = crypto.createHmac('sha256', APISecret);
        hmac.update(signatureOrigin);
        const signature = hmac.digest('base64');
        const authorizationOrigin = `api_key="${APIKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
        const authorization = Buffer.from(authorizationOrigin).toString('base64');
        const url = `${BASE_URL}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${HOST}`;
        res.json({ url });
    });

// 新增：定时清理 audio_temp 下1小时以上的临时文件
setInterval(() => {
    const now = Date.now();
    fs.readdir(audioTempDir, (err, files) => {
        if (err) return;
        files.forEach(file => {
            const filePath = path.join(audioTempDir, file);
            fs.stat(filePath, (err2, stat) => {
                if (err2) return;
                if (now - stat.mtimeMs > 60 * 60 * 1000) { // 1小时
                    fs.unlink(filePath, () => {});
                }
            });
        });
    });
}, 30 * 60 * 1000); // 每30分钟检查一次

const ffmpegPath = 'ffmpeg'; // 只用系统 PATH 下的 ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

function checkFfmpegAvailable() {
    const { spawnSync } = require('child_process');
    const result = spawnSync(ffmpegPath, ['-version']);
    if (result.error || result.status !== 0) {
        console.error('\n[错误] 未检测到 ffmpeg 可执行文件，请安装 ffmpeg 并将其加入系统 PATH。\n' +
            '下载地址: https://ffmpeg.org/download.html\n' +
            'Windows推荐: https://www.gyan.dev/ffmpeg/builds/\n' +
            '安装后重启命令行窗口再运行本服务。\n');
        process.exit(1);
    }
}
checkFfmpegAvailable();

// 新增：初始化口语和听力训练表
function initOralListeningTable() {
    db.run(`CREATE TABLE IF NOT EXISTS oral_listening_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        unit TEXT NOT NULL,
        level INTEGER NOT NULL,
        type TEXT NOT NULL,
        duration TEXT NOT NULL,
        fastest_duration TEXT,
        completed_at TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_oral_listening_user_unit_type 
        ON oral_listening_progress(username, unit, type)`);
    db.serialize(() => {
    db.run(`ALTER TABLE oral_listening_progress ADD COLUMN gradeKey TEXT`, () => {});
});
}

// 新增：每周一0点清空 oral_listening_progress 表
function getNextMondayMidnight() {
    const now = new Date();
    const day = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const daysUntilMonday = (8 - day) % 7;
    const nextMonday = new Date(now);
    nextMonday.setDate(now.getDate() + daysUntilMonday);
    nextMonday.setHours(0, 0, 0, 0);
    return nextMonday.getTime();
}
function scheduleOralListeningWeeklyClear() {
    const now = Date.now();
    const nextMonday = getNextMondayMidnight();
    const msUntilNextMonday = nextMonday - now;
    setTimeout(() => {
        db.run('DELETE FROM oral_listening_progress', function(err) {
            if (err) {
                console.error('清零口语听力训练记录失败:', err);
            } else {
                console.log('口语听力训练记录已清零');
            }
        });
        // 之后每14天清理一次
        setInterval(() => {
            db.run('DELETE FROM oral_listening_progress', function(err) {
                if (err) {
                    console.error('清零口语听力训练记录失败:', err);
                } else {
                    console.log('口语听力训练记录已清零');
                }
            });
        }, 7 * 24 * 3600 * 1000 * 2); // 每两周清理一次
    }, msUntilNextMonday);
}

// 修复保存进度接口
app.post('/api/oral-listening/save-progress', (req, res) => {
    const { username, unit, level, type, duration, completed_at, gradeKey } = req.body;
    if (!username || !unit || !level || !type || !duration) {
        return res.json({ success: false, message: '参数不完整' });
    }
    
    // 先查询是否存在记录
    const selectSQL = `
        SELECT fastest_duration FROM oral_listening_progress 
        WHERE username = ? AND unit = ? AND type = ?
    `;
    
    db.get(selectSQL, [username, unit, type], (err, row) => {
        if (err) {
            console.error('查询进度失败:', err);
            return res.json({ success: false, message: '数据库查询错误' });
        }
        
        // 计算最快用时
        let fastest = duration;
        if (row && row.fastest_duration) {
            const currentSeconds = convertDurationToSeconds(duration);
            const fastestSeconds = convertDurationToSeconds(row.fastest_duration);
            if (fastestSeconds < currentSeconds) {
                fastest = row.fastest_duration;
            }
        }
        
        // 使用 REPLACE 替代复杂的 INSERT OR UPDATE
        const replaceSQL = `
            REPLACE INTO oral_listening_progress 
            (username, unit, level, type, duration, fastest_duration, completed_at, gradeKey, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `;
        
        db.run(
            replaceSQL,
            [username, unit, level, type, duration, fastest, completed_at, gradeKey || null],
            function (err2) {
                if (err2) {
                    console.error('保存进度失败:', err2);
                    return res.json({ success: false, message: '保存失败: ' + err2.message });
                }
                res.json({ success: true });
            }
        );
    });
});

// 3. 新增：获取所有可用年级（gradeKey）
app.get('/api/oral-listening/available-grades', (req, res) => {
    db.all(`SELECT DISTINCT gradeKey FROM oral_listening_progress WHERE gradeKey IS NOT NULL`, [], (err, rows) => {
        if (err) return res.json([]);
        const gradeKeys = rows.map(r => r.gradeKey).filter(Boolean);
        res.json(gradeKeys);
    });
});

// 4. 新增：获取某年级下所有可用单元
app.get('/api/oral-listening/available-units', (req, res) => {
    const { gradeKey } = req.query;
    if (!gradeKey) return res.json([]);
    db.all(`SELECT DISTINCT unit FROM oral_listening_progress WHERE gradeKey = ?`, [gradeKey], (err, rows) => {
        if (err) return res.json([]);
        const units = rows.map(r => r.unit);
        res.json(units);
    });
});

// 新增：口语听力进度加载API
app.get('/api/oral-listening/progress', (req, res) => {
    const { username, unit, type } = req.query;
    if (!username || !unit || !type) {
        return res.json({ success: false, message: '参数不完整' });
    }
    const selectSQL = `
        SELECT level, duration, fastest_duration, completed_at 
        FROM oral_listening_progress 
        WHERE username = ? AND unit = ? AND type = ?
        ORDER BY updated_at DESC 
        LIMIT 1
    `;
    db.get(selectSQL, [username, unit, type], (err, row) => {
        if (err) return res.json({ success: false, message: '查询失败' });
        if (!row) return res.json({ success: true, level: 1, message: '暂无记录' });
        res.json({ 
            success: true, 
            level: row.level,
            duration: row.duration,
            fastest_duration: row.fastest_duration,
            completed_at: row.completed_at
        });
    });
});

// 5. 查询记录时返回 gradeKey 字段
app.get('/api/oral-listening/records', (req, res) => {
    const { username, unit, type, gradeKey } = req.query;
    let whereClause = 'WHERE 1=1';
    let params = [];
    if (username) { whereClause += ' AND username = ?'; params.push(username); }
    if (unit) { whereClause += ' AND unit = ?'; params.push(unit); }
    if (type) { whereClause += ' AND type = ?'; params.push(type); }
    if (gradeKey) { whereClause += ' AND gradeKey = ?'; params.push(gradeKey); }
    const selectSQL = `
        SELECT unit, level, type, duration, fastest_duration, completed_at, gradeKey
        FROM oral_listening_progress 
        ${whereClause}
        ORDER BY completed_at DESC
    `;
    db.all(selectSQL, params, (err, rows) => {
        if (err) return res.json({ success: false, records: [] });
        res.json({ success: true, records: rows });
    });
});

// 工具函数：字符串转秒数（用于最快用时比较）
function convertDurationToSeconds(duration) {
    if (!duration || typeof duration !== 'string') return 99999;
    const parts = duration.split(':');
    if (parts.length !== 2) return 99999;
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

// 启动服务
//app.listen(PORT, () => {
    ;
    
    // 新增：初始化口语听力表
//    initOralListeningTable();
//});

// 新增：留言板表初始化
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // 创建索引提高查询效率
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_category ON messages(category)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`);
});

// 新增：发送留言接口
app.post('/api/messages', (req, res) => {
    const { category, author, content, timestamp } = req.body;
    
    if (!category || !author || !content || !timestamp) {
        return res.status(400).json({ error: '缺少必要参数' });
    }
    
    // 验证用户身份（可选：检查用户是否已登录）
    // 这里可以添加用户权限验证逻辑
    
    // 内容长度限制
    if (content.length > 1000) {
        return res.status(400).json({ error: '留言内容过长，最多1000字符' });
    }
    
    const now = new Date().toISOString();
    
    db.run(
        `INSERT INTO messages (category, author, content, timestamp, created_at) 
         VALUES (?, ?, ?, ?, ?)`,
        [category, author, content, timestamp, now],
        function(err) {
            if (err) {
                console.error('保存留言失败:', err);
                return res.status(500).json({ error: '保存留言失败' });
            }
            
            res.json({ 
                success: true, 
                id: this.lastID,
                message: '留言发送成功'
            });
        }
    );
});

// 新增：获取留言接口
app.get('/api/messages', (req, res) => {
    const { category, limit = 50, offset = 0 } = req.query;
    
    if (!category) {
        return res.status(400).json({ error: '缺少分类参数' });
    }
    
    // 限制每次最多获取100条消息
    const maxLimit = Math.min(parseInt(limit) || 50, 100);
    const offsetNum = parseInt(offset) || 0;
    
    db.all(
        `SELECT id, category, author, content, timestamp, created_at
         FROM messages 
         WHERE category = ?
         ORDER BY timestamp ASC
         LIMIT ? OFFSET ?`,
        [category, maxLimit, offsetNum],
        (err, rows) => {
            if (err) {
                console.error('获取留言失败:', err);
                return res.status(500).json({ error: '获取留言失败' });
            }
            
            res.json(rows || []);
        }
    );
});

// 新增：获取留言数量接口
app.get('/api/messages/count', (req, res) => {
    const { category } = req.query;
    
    if (!category) {
        return res.status(400).json({ error: '缺少分类参数' });
    }
    
    db.get(
        `SELECT COUNT(*) as count FROM messages WHERE category = ?`,
        [category],
        (err, row) => {
            if (err) {
                console.error('获取留言数量失败:', err);
                return res.status(500).json({ error: '获取留言数量失败' });
            }
            
            res.json({ count: row ? row.count : 0 });
        }
    );
});

// 新增：删除留言接口（管理员功能）
app.delete('/api/messages/:id', (req, res) => {
    const { id } = req.params;
    const { username } = req.body; // 需要验证删除权限
    
    if (!id) {
        return res.status(400).json({ error: '缺少留言ID' });
    }
    
    // 这里可以添加权限验证，例如只有管理员或留言作者才能删除
    // 暂时简化处理
    
    db.run(
        `DELETE FROM messages WHERE id = ?`,
        [id],
        function(err) {
            if (err) {
                console.error('删除留言失败:', err);
                return res.status(500).json({ error: '删除留言失败' });
            }
            
            if (this.changes === 0) {
                return res.status(404).json({ error: '留言不存在' });
            }
            
            res.json({ success: true, message: '留言删除成功' });
        }
    );
});

// 新增：获取所有分类的留言概览（管理员功能）
app.get('/api/messages/overview', (req, res) => {
    db.all(
        `SELECT category, 
                COUNT(*) as message_count,
                MAX(timestamp) as latest_message_time,
                author as latest_author
         FROM messages 
         GROUP BY category
         ORDER BY latest_message_time DESC`,
        [],
        (err, rows) => {
            if (err) {
                console.error('获取留言概览失败:', err);
                return res.status(500).json({ error: '获取留言概览失败' });
            }
            
            res.json(rows || []);
        }
    );
});

// 新增：清理旧留言接口（管理员功能，清理30天前的留言）
app.post('/api/messages/cleanup', (req, res) => {
    const { username, days = 30 } = req.body;
    
    // 这里应该添加管理员权限验证
    // 暂时简化处理
    
    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(days));
    const cutoffDate = daysAgo.toISOString();
    
    db.run(
        `DELETE FROM messages WHERE timestamp < ?`,
        [cutoffDate],
        function(err) {
            if (err) {
                console.error('清理旧留言失败:', err);
                return res.status(500).json({ error: '清理旧留言失败' });
            }
            
            res.json({ 
                success: true, 
                deletedCount: this.changes,
                message: `成功清理${this.changes}条${days}天前的留言`
            });
        }
    );
});

// 修改：在 /api/export-all-alldata 接口中添加 messages 表
app.get('/api/export-all-alldata', (req, res) => {
    const tables = [
        'records',
        'students',
        'registered_stu',
        'king_unlocks',
        'task',
        'task_assignment',
        'student_task_submit',
        'class',
        'class_student',
        'messages'  // 新增：包含留言板数据
    ];
    let result = {};
    let pending = tables.length;
    tables.forEach(table => {
        db.all(`SELECT * FROM ${table}`, [], (err, rows) => {
            result[table] = rows || [];
            if (--pending === 0) {
                res.setHeader('Content-Type', 'application/json');
                res.json(result);
            }
        });
    });
});


// 预习课文单词训练记录模块开始
// 1. 初始化表
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS prerev_record (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        grade TEXT NOT NULL,
        unit TEXT NOT NULL,
        duration TEXT NOT NULL,
        correct INTEGER NOT NULL,
        total INTEGER NOT NULL,
        accuracy REAL NOT NULL,
        time TEXT NOT NULL
    )`);
});

// 2. 上报训练结果接口
app.post('/api/prerev/record', (req, res) => {
    const { username, grade, unit, duration, correct, total, accuracy, time } = req.body;
    if (!username || !grade || !unit || !duration || typeof correct !== 'number' || typeof total !== 'number' || typeof accuracy !== 'number' || !time) {
        return res.status(400).json({ error: '参数不完整' });
    }
    db.run(
        `INSERT INTO prerev_record (username, grade, unit, duration, correct, total, accuracy, time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [username, grade, unit, duration, correct, total, accuracy, time],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        }
    );
});

// 3. 查询训练记录接口（支持按用户名、年级、单元筛选）
app.get('/api/prerev/records', (req, res) => {
    const { username, grade, unit } = req.query;
    let sql = `SELECT * FROM prerev_record WHERE 1=1`;
    const params = [];
    if (username) { sql += ` AND username=?`; params.push(username); }
    if (grade) { sql += ` AND grade=?`; params.push(grade); }
    if (unit) { sql += ` AND unit=?`; params.push(unit); }
    sql += ` ORDER BY time DESC`;
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});
// 预习课文单词训练记录模块结束

// 预习大师赛解锁表模块开始
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS prerev_master_unlock (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        grade TEXT NOT NULL,
        unit TEXT NOT NULL,
        unlockedAt TEXT NOT NULL,
        UNIQUE(username, grade, unit)
    )`);
});

// 新增：上报解锁接口
app.post('/api/prerev/master-unlock', (req, res) => {
    const { username, grade, unit, unlockedAt } = req.body;
    if (!username || !grade || !unit || !unlockedAt) {
        return res.status(400).json({ error: '参数不完整' });
    }
    db.run(
        `INSERT INTO prerev_master_unlock (username, grade, unit, unlockedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(username, grade, unit) DO UPDATE SET unlockedAt=excluded.unlockedAt`,
        [username, grade, unit, unlockedAt],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// 新增：查询某用户某单元是否已解锁大师赛
app.get('/api/prerev/master-unlock', (req, res) => {
    const { username, grade, unit } = req.query;
    if (!username || !grade || !unit) return res.json({ unlocked: false });
    db.get(
        `SELECT 1 FROM prerev_master_unlock WHERE username = ? AND grade = ? AND unit = ?`,
        [username, grade, unit],
        (err, row) => {
            if (err) return res.json({ unlocked: false });
            res.json({ unlocked: !!row });
        }
    );
});

// 新增：查询已解锁单元接口
app.get('/api/prerev/master-unlocked-units', (req, res) => {
    const { username, grade } = req.query;
    if (!username || !grade) return res.json([]);
    db.all(
        `SELECT unit FROM prerev_master_unlock WHERE username = ? AND grade = ?`,
        [username, grade],
        (err, rows) => {
            if (err) return res.json([]);
            res.json({ units: rows.map(r => r.unit) });
        }
    );
});
// 预习大师赛解锁表模块结束

// ...existing code...

// 预习大师赛训练记录表模块开始
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS prerev_master_record (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        grade TEXT NOT NULL,
        unit TEXT NOT NULL,
        duration TEXT NOT NULL,
        correct INTEGER NOT NULL,
        total INTEGER NOT NULL,
        accuracy REAL NOT NULL,
        time TEXT NOT NULL
    )`);
});

// 上报大师赛训练记录接口
app.post('/api/prerev/master-record', (req, res) => {
    const { username, grade, unit, duration, correct, total, accuracy, time } = req.body;
    if (!username || !grade || !unit || !duration || typeof correct !== 'number' || typeof total !== 'number' || typeof accuracy !== 'number' || !time) {
        return res.status(400).json({ error: '参数不完整' });
    }
    db.run(
        `INSERT INTO prerev_master_record (username, grade, unit, duration, correct, total, accuracy, time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [username, grade, unit, duration, correct, total, accuracy, time],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        }
    );
});

// 查询大师赛训练记录接口（支持按用户名、年级、单元筛选）
app.get('/api/prerev/master-records', (req, res) => {
    const { username, grade, unit } = req.query;
    let sql = `SELECT * FROM prerev_master_record WHERE 1=1`;
    const params = [];
    if (username) { sql += ` AND username=?`; params.push(username); }
    if (grade) { sql += ` AND grade=?`; params.push(grade); }
    if (unit) { sql += ` AND unit=?`; params.push(unit); }
    sql += ` ORDER BY time DESC`;
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// 删除预习课文类单词大师赛所有训练记录接口
app.post('/api/prerev/master-records/clear', (req, res) => {
    db.run('DELETE FROM prerev_master_record', function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, deleted: this.changes });
    });
});

// 预习大师赛错误单词历史表
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS prewrongwords (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        grade TEXT NOT NULL,
        unit TEXT NOT NULL,
        date TEXT NOT NULL,
        wrongwords TEXT NOT NULL
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_prewrongwords_user_grade_unit_date ON prewrongwords(username, grade, unit, date)`);
});

// 保存预习大师赛错误单词历史
app.post('/api/prerev/save-wrongwords', (req, res) => {
    const { username, grade, unit, date, wrongwords } = req.body;
    if (!username || !grade || !unit || !date || !Array.isArray(wrongwords)) {
        return res.status(400).json({ error: '参数不完整' });
    }
    // 插入新记录
    db.run(
        `INSERT INTO prewrongwords (username, grade, unit, date, wrongwords) VALUES (?, ?, ?, ?, ?)`,
        [username, grade, unit, date, JSON.stringify(wrongwords)],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            // 删除多余的，只保留最近10条
            db.all(
                `SELECT id FROM prewrongwords WHERE username=? AND grade=? AND unit=? ORDER BY date DESC, id DESC`,
                [username, grade, unit],
                (err2, rows) => {
                    if (err2) return res.status(500).json({ error: err2.message });
                    if (rows.length > 10) {
                        const toDelete = rows.slice(10).map(r => r.id);
                        db.run(
                            `DELETE FROM prewrongwords WHERE id IN (${toDelete.map(() => '?').join(',')})`,
                            toDelete,
                            () => res.json({ success: true })
                        );
                    } else {
                        res.json({ success: true });
                    }
                }
            );
        }
    );
});

// 查询本年级本单元所有有记录的用户名
app.get('/api/prerev/wrongwords-users', (req, res) => {
    const { grade, unit } = req.query;
    if (!grade || !unit) return res.status(400).json({ error: '缺少参数' });
    db.all(
        `SELECT DISTINCT username FROM prewrongwords WHERE grade=? AND unit=? ORDER BY username COLLATE NOCASE`,
        [grade, unit],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows.map(r => r.username));
        }
    );
});

// 查询某用户最近10次记录（返回id和date）
app.get('/api/prerev/wrongwords-dates', (req, res) => {
    const { username, grade, unit } = req.query;
    if (!username || !grade || !unit) return res.status(400).json({ error: '缺少参数' });
    db.all(
        `SELECT id, date FROM prewrongwords WHERE username=? AND grade=? AND unit=? ORDER BY date DESC, id DESC LIMIT 10`,
        [username, grade, unit],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// 查询某条记录的错误单词详情
app.get('/api/prerev/wrongwords-detail', (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: '缺少id参数' });
    db.get(
        `SELECT wrongwords FROM prewrongwords WHERE id=?`,
        [id],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            let wrongwords = [];
            try { wrongwords = JSON.parse(row?.wrongwords || '[]'); } catch {}
            res.json({ wrongwords });
        }
    );
});
// 预习大师赛训练记录表模块结束

// 新增：课文管理模块（textmanage）
// 1. 新建 textmanage 表（建议放在数据库初始化部分）
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS textmanage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tag_key TEXT NOT NULL,         -- 类（如 tongxing/pep/waiyan/gaozhong）
        tag_name TEXT NOT NULL,        -- 类名（如 童行英语）
        sub_name TEXT NOT NULL,        -- 年级/项目（如 三年级上）
        unit_name TEXT NOT NULL,       -- 单元名（如 Unit 1）
        text_content TEXT,             -- 单元文本内容
        audio_file TEXT,               -- 匹配音频文件名（如 audio.mp3）
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_textmanage_unique 
        ON textmanage(tag_key, sub_name, unit_name)`);
});
/**
 * 获取所有课文类、年级/项目、单元结构（树状结构，含文本和音频）
 * 用于任务发布页下拉选择或预览
 */
app.get('/api/textmanage/tree', (req, res) => {
    db.all(`SELECT * FROM textmanage`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // 构建树状结构，过滤空项和空单元
        const tree = {};
        rows.forEach(row => {
            if (!row.sub_name || !row.sub_name.trim()) return; // 跳过空项
            if (!tree[row.tag_key]) {
                tree[row.tag_key] = { tag_name: row.tag_name, subs: {} };
            }
            if (!tree[row.tag_key].subs[row.sub_name]) {
                tree[row.tag_key].subs[row.sub_name] = [];
            }
            if (row.unit_name && row.unit_name.trim()) { // 跳过空单元
                tree[row.tag_key].subs[row.sub_name].push({
                    unit_name: row.unit_name,
                    text_content: row.text_content,
                    audio_file: row.audio_file
                });
            }
        });
        res.json(tree);
    });
});
/**
 * 获取指定单元的课文文本和音频（任务发布页、学生端调用）
 * 参数：tag_key, sub_name, unit_name
 */
app.get('/api/textmanage/unit', (req, res) => {
    const { tag_key, sub_name, unit_name } = req.query;
    if (!tag_key || !sub_name || !unit_name) return res.status(400).json({ error: '缺少参数' });
    db.get(
        `SELECT * FROM textmanage WHERE tag_key=? AND sub_name=? AND unit_name=?`,
        [tag_key, sub_name, unit_name],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(row || {});
        }
    );
});

/**
 * 获取某个年级/项目下所有单元（用于前端选择）
 * 参数：tag_key, sub_name
 */
app.get('/api/textmanage/units', (req, res) => {
    const { tag_key, sub_name } = req.query;
    if (!tag_key || !sub_name) return res.status(400).json({ error: '缺少参数' });
    db.all(
        `SELECT unit_name FROM textmanage WHERE tag_key=? AND sub_name=?`,
        [tag_key, sub_name],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows.map(r => r.unit_name));
        }
    );
});

/**
 * 获取所有课文类（tag_key, tag_name）
 */
app.get('/api/textmanage/tags', (req, res) => {
    db.all(`SELECT DISTINCT tag_key, tag_name FROM textmanage`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

/**
 * 获取某类下所有年级/项目（sub_name）
 * 参数：tag_key
 */
app.get('/api/textmanage/subs', (req, res) => {
    const { tag_key } = req.query;
    if (!tag_key) return res.status(400).json({ error: '缺少参数' });
    db.all(
        `SELECT DISTINCT sub_name FROM textmanage WHERE tag_key=? AND sub_name<>''`,
        [tag_key],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows.map(r => r.sub_name));
        }
    );
});

/**
 * 添加新类
 */
app.post('/api/textmanage/add-tag', (req, res) => {
    const { tag_key, tag_name } = req.body;
    if (!tag_key || !tag_name) return res.status(400).json({ error: '缺少参数' });
    const now = new Date().toISOString();
    db.run(
        `INSERT INTO textmanage (tag_key, tag_name, sub_name, unit_name, created_at, updated_at) VALUES (?, ?, '', '', ?, ?)`,
        [tag_key, tag_name, now, now],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

/**
 * 添加新项（年级/项目）
 */
app.post('/api/textmanage/add-sub', (req, res) => {
    const { tag_key, tag_name, sub_name } = req.body;
    if (!tag_key || !tag_name || !sub_name) return res.status(400).json({ error: '缺少参数' });
    const now = new Date().toISOString();
    db.run(
        `INSERT INTO textmanage (tag_key, tag_name, sub_name, unit_name, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)`,
        [tag_key, tag_name, sub_name, now, now],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

/**
 * 添加新单元
 */
app.post('/api/textmanage/add-unit', (req, res) => {
    const { tag_key, tag_name, sub_name, unit_name } = req.body;
    if (!tag_key || !tag_name || !sub_name || !unit_name) return res.status(400).json({ error: '缺少参数' });
    const now = new Date().toISOString();
    db.run(
        `INSERT INTO textmanage (tag_key, tag_name, sub_name, unit_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [tag_key, tag_name, sub_name, unit_name, now, now],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

/**
 * 修改单元名称
 * 参数：tag_key, sub_name, old_unit_name, new_unit_name
 */
app.post('/api/textmanage/update-unit-name', (req, res) => {
    const { tag_key, sub_name, old_unit_name, new_unit_name } = req.body;
    if (!tag_key || !sub_name || !old_unit_name || !new_unit_name) {
        return res.status(400).json({ error: '缺少参数' });
    }
    const now = new Date().toISOString();
    db.run(
        `UPDATE textmanage SET unit_name=?, updated_at=? WHERE tag_key=? AND sub_name=? AND unit_name=?`,
        [new_unit_name, now, tag_key, sub_name, old_unit_name],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: '未找到该单元' });
            res.json({ success: true });
        }
    );
});

/**
 * 编辑/保存单元文本
 */
app.post('/api/textmanage/save-text', (req, res) => {
    const { tag_key, sub_name, unit_name, text_content } = req.body;
    if (!tag_key || !sub_name || !unit_name) return res.status(400).json({ error: '缺少参数' });
    const now = new Date().toISOString();
    db.run(
        `UPDATE textmanage SET text_content=?, updated_at=? WHERE tag_key=? AND sub_name=? AND unit_name=?`,
        [text_content, now, tag_key, sub_name, unit_name],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// 新增：递归列出音频文件和目录的API
const AUDIO_ROOTS = {
    'preread/audio': path.join(__dirname, 'preread', 'audio'),
    'homework/textaudio': path.join(__dirname, 'homework', 'textaudio')
};

function listAudioDirTree(rootKey, relPath = '') {
    const absRoot = AUDIO_ROOTS[rootKey];
    if (!absRoot) return null;
    const absPath = path.join(absRoot, relPath);
    if (!fs.existsSync(absPath)) return null;
    const stat = fs.statSync(absPath);
    if (!stat.isDirectory()) return null;

    const children = [];
    const files = fs.readdirSync(absPath);
    files.forEach(name => {
        const fullPath = path.join(absPath, name);
        const relChildPath = path.join(relPath, name).replace(/\\/g, '/');
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            children.push({
                name,
                path: `${rootKey}/${relChildPath}`,
                isDir: true
            });
        } else if (/\.(mp3|wav|m4a|aac|ogg)$/i.test(name)) {
            children.push({
                name,
                path: `${rootKey}/${relChildPath}`,
                isDir: false
            });
        }
    });
    return {
        name: relPath ? relPath : rootKey,
        path: relPath ? `${rootKey}/${relPath}` : rootKey,
        isDir: true,
        children
    };
}

// 音频目录树API
app.get('/api/list-audio-files', (req, res) => {
    const { dir } = req.query;
    if (!dir || !(dir in AUDIO_ROOTS)) {
        // 允许递归子目录
        let rootKey = null;
        for (const k in AUDIO_ROOTS) {
            if (dir && dir.startsWith(k)) {
                rootKey = k;
                break;
            }
        }
        if (!rootKey) return res.status(400).json({ error: '无效目录' });
        const relPath = dir.slice(rootKey.length).replace(/^\/+/, '');
        const tree = listAudioDirTree(rootKey, relPath);
        return res.json(tree || { name: dir, path: dir, isDir: true, children: [] });
    }
    // 顶层
    const tree = listAudioDirTree(dir);
    res.json(tree || { name: dir, path: dir, isDir: true, children: [] });
});

/**
 * 匹配/保存音频
 */
app.post('/api/textmanage/save-audio', (req, res) => {
    const { tag_key, sub_name, unit_name, audio_file } = req.body;
    if (!tag_key || !sub_name || !unit_name) return res.status(400).json({ error: '缺少参数' });
    const now = new Date().toISOString();
    db.run(
        `UPDATE textmanage SET audio_file=?, updated_at=? WHERE tag_key=? AND sub_name=? AND unit_name=?`,
        [audio_file, now, tag_key, sub_name, unit_name],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

/**
 * 删除单元
 */
app.post('/api/textmanage/delete-unit', (req, res) => {
    const { tag_key, sub_name, unit_name } = req.body;
    if (!tag_key || !sub_name || !unit_name) return res.status(400).json({ error: '缺少参数' });
    db.run(
        `DELETE FROM textmanage WHERE tag_key=? AND sub_name=? AND unit_name=?`,
        [tag_key, sub_name, unit_name],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

/**
 * 删除项（年级/项目），仅当该项下无单元
 */
app.post('/api/textmanage/delete-sub', (req, res) => {
    const { tag_key, sub_name } = req.body;
    if (!tag_key || !sub_name) return res.status(400).json({ error: '缺少参数' });
    // 检查是否有单元
    db.all(
        `SELECT * FROM textmanage WHERE tag_key=? AND sub_name=? AND unit_name<>''`,
        [tag_key, sub_name],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            if (rows && rows.length > 0) {
                return res.status(400).json({ error: '请先删除该项下所有单元' });
            }
            // 删除该项
            db.run(
                `DELETE FROM textmanage WHERE tag_key=? AND sub_name=?`,
                [tag_key, sub_name],
                function(err2) {
                    if (err2) return res.status(500).json({ error: err2.message });
                    res.json({ success: true });
                }
            );
        }
    );
});

/**
 * 删除类，仅当该类下无项
 */
app.post('/api/textmanage/delete-tag', (req, res) => {
    const { tag_key } = req.body;
    if (!tag_key) return res.status(400).json({ error: '缺少参数' });
    // 检查是否有项
    db.all(
        `SELECT * FROM textmanage WHERE tag_key=? AND sub_name<>''`,
        [tag_key],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            if (rows && rows.length > 0) {
                return res.status(400).json({ error: '请先删除该类下所有项及其单元' });
            }
            // 删除该类
            db.run(
                `DELETE FROM textmanage WHERE tag_key=?`,
                [tag_key],
                function(err2) {
                    if (err2) return res.status(500).json({ error: err2.message });
                    res.json({ success: true });
                }
            );
        }
    );
});

/**
 * 移动项（sub）及其所有单元到其他类
 * 参数：from_tag_key, from_tag_name, sub_name, to_tag_key, to_tag_name
 */
app.post('/api/textmanage/move-sub', (req, res) => {
    const { from_tag_key, from_tag_name, sub_name, to_tag_key, to_tag_name } = req.body;
    if (!from_tag_key || !from_tag_name || !sub_name || !to_tag_key || !to_tag_name) {
        return res.status(400).json({ error: '缺少参数' });
    }
    // 查询原项下所有单元
    db.all(
        `SELECT * FROM textmanage WHERE tag_key=? AND sub_name=?`,
        [from_tag_key, sub_name],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!rows || rows.length === 0) {
                return res.status(404).json({ error: '未找到要移动的项' });
            }
            // 检查目标类下是否已存在同名项
            db.all(
                `SELECT * FROM textmanage WHERE tag_key=? AND sub_name=?`,
                [to_tag_key, sub_name],
                (err2, existRows) => {
                    if (err2) return res.status(500).json({ error: err2.message });
                    // 构建目标已有单元名集合
                    const existUnits = new Set((existRows || []).map(r => r.unit_name));
                    const now = new Date().toISOString();
                    // 先插入到目标类
                    let pending = rows.length;
                    let hasError = false;
                    rows.forEach(row => {
                        // 跳过空项（sub行）
                        if (!row.unit_name || !row.unit_name.trim()) {
                            // 目标类下没有该项则插入空项行
                            if (!existRows.find(r => !r.unit_name || !r.unit_name.trim())) {
                                db.run(
                                    `INSERT INTO textmanage (tag_key, tag_name, sub_name, unit_name, text_content, audio_file, created_at, updated_at)
                                     VALUES (?, ?, ?, '', '', '', ?, ?)`,
                                    [to_tag_key, to_tag_name, sub_name, now, now],
                                    function(err3) {
                                        if (err3 && !hasError) { hasError = true; return res.status(500).json({ error: err3.message }); }
                                        if (--pending === 0 && !hasError) finishMove();
                                    }
                                );
                            } else {
                                if (--pending === 0 && !hasError) finishMove();
                            }
                        } else {
                            // 单元名冲突则覆盖
                            db.run(
                                `INSERT OR REPLACE INTO textmanage (tag_key, tag_name, sub_name, unit_name, text_content, audio_file, created_at, updated_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                                [to_tag_key, to_tag_name, sub_name, row.unit_name, row.text_content, row.audio_file, now, now],
                                function(err4) {
                                    if (err4 && !hasError) { hasError = true; return res.status(500).json({ error: err4.message }); }
                                    if (--pending === 0 && !hasError) finishMove();
                                }
                            );
                        }
                    });
                    function finishMove() {
                        // 删除原类下该项及所有单元
                        db.run(
                            `DELETE FROM textmanage WHERE tag_key=? AND sub_name=?`,
                            [from_tag_key, sub_name],
                            function(err5) {
                                if (err5) return res.status(500).json({ error: err5.message });
                                res.json({ success: true });
                            }
                        );
                    }
                }
            );
        }
    );
});
//课文文本与音频匹配管理API结束

// 新增：永久名单添加学生接口
app.post('/api/permanent-stu/add', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, error: '缺少参数' });
    }
    // 检查是否已存在
    db.get('SELECT username FROM students WHERE username = ?', [username], (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (row) return res.status(409).json({ success: false, error: '该学生已存在' });
        db.run(
            'INSERT INTO students (username, password) VALUES (?, ?)',
            [username, password],
            function (err2) {
                if (err2) return res.status(500).json({ success: false, error: err2.message });
                res.json({ success: true });
            }
        );
    });
});

// 新增：删除永久名单学生接口
app.post('/api/permanent-stu/delete', (req, res) => {
    const { username } = req.body;
    if (!username) {
        return res.status(400).json({ success: false, error: '缺少参数' });
    }
    db.run(`DELETE FROM students WHERE username=?`, [username], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true });
    });
});

// 新增：公告表初始化
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        is_active INTEGER DEFAULT 1
    )`);
});

// 新增：获取最新公告接口
app.get('/api/announcements/latest', (req, res) => {
    db.get(
        `SELECT * FROM announcements WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1`,
        [],
        (err, row) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json(row || null);
        }
    );
});

// 新增：发布公告接口
app.post('/api/announcements', (req, res) => {
    const { title, content } = req.body;
    if (!title || !content) {
        return res.status(400).json({ error: '标题和内容不能为空' });
    }
    
    const now = new Date().toISOString();
    
    // 先将所有公告设置为不活跃
    db.run(`UPDATE announcements SET is_active = 0`, [], (err) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        // 插入新公告
        db.run(
            `INSERT INTO announcements (title, content, created_at, is_active) VALUES (?, ?, ?, 1)`,
            [title, content, now],
            function(err2) {
                if (err2) {
                    return res.status(500).json({ error: err2.message });
                }
                res.json({ 
                    success: true, 
                    id: this.lastID,
                    message: '公告发布成功'
                });
            }
        );
    });
});

// 新增：获取所有公告接口（管理用）
app.get('/api/announcements', (req, res) => {
    db.all(
        `SELECT * FROM announcements ORDER BY created_at DESC`,
        [],
        (err, rows) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json(rows || []);
        }
    );
});

// 替换现有的 Google TTS API 接口
app.post('/api/google-tts', async (req, res) => {
    try {
        const { text, voice = 'Enceladus' } = req.body;
        
        console.log('收到TTS请求:', { text: text?.substring(0, 50), voice });
        
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            console.error('文本内容为空或无效');
            return res.status(400).json({ error: '缺少文本内容' });
        }
        
        // 检查 Google API Key
        const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'AIzaSyBdUuHIN43sgP9aQaUM7V25gHKymErH688';
        
        if (!GOOGLE_API_KEY) {
            console.error('Google API Key 未配置');
            return res.status(500).json({ error: 'Google API Key 未配置' });
        }
        
        console.log('使用 Google API Key:', GOOGLE_API_KEY.substring(0, 10) + '...');
        
        // 验证语音名称
        const validVoices = ['Enceladus', 'Fenrir', 'Aoede', 'Charon'];
        const selectedVoice = validVoices.includes(voice) ? voice : 'Enceladus';
        
        // Google TTS API 请求参数
        const requestBody = {
            input: { text: text.trim() },
            voice: {
                name: `en-US-${selectedVoice}`,
                languageCode: 'en-US'
            },
            audioConfig: {
                audioEncoding: 'LINEAR16',
                sampleRateHertz: 22050
            }
        };
        
        console.log('发送请求到 Google TTS API:', {
            voiceName: requestBody.voice.name,
            textLength: text.length
        });
        
        // 调用 Google TTS API
        const response = await axios.post(
            `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_API_KEY}`,
            requestBody,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'WordsReciting/1.0'
                },
                timeout: 30000, // 增加超时时间到30秒
                validateStatus: function (status) {
                    return status < 500; // 不要对4xx错误抛出异常
                }
            }
        );
        
        console.log('Google API 响应状态:', response.status);
        
        if (response.status !== 200) {
            console.error('Google API 错误响应:', {
                status: response.status,
                statusText: response.statusText,
                data: response.data
            });
            
            let errorMessage = 'Google TTS API 请求失败';
            
            if (response.status === 400) {
                errorMessage = 'API 请求参数错误';
            } else if (response.status === 403) {
                errorMessage = 'API Key 无效或权限不足';
            } else if (response.status === 429) {
                errorMessage = 'API 请求频率超限，请稍后重试';
            } else if (response.data?.error?.message) {
                errorMessage = response.data.error.message;
            }
            
            return res.status(response.status).json({ error: errorMessage });
        }
        
        if (!response.data || !response.data.audioContent) {
            console.error('Google API 返回数据异常:', response.data);
            return res.status(500).json({ error: 'Google TTS API 返回数据异常' });
        }
        
        console.log('成功获取音频数据，长度:', response.data.audioContent.length);
        
        // 将 base64 音频数据转换为 Buffer
        const audioBuffer = Buffer.from(response.data.audioContent, 'base64');
        
        console.log('音频缓冲区大小:', audioBuffer.length, 'bytes');
        
        // 设置响应头
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', audioBuffer.length);
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        // 返回音频数据
        res.send(audioBuffer);
        
        console.log('TTS 请求处理完成');
        
    } catch (error) {
        console.error('Google TTS API 详细错误:', {
            message: error.message,
            code: error.code,
            response: error.response?.data,
            status: error.response?.status,
            stack: error.stack
        });
        
        let errorMessage = '内部服务器错误';
        let statusCode = 500;
        
        if (error.response) {
            // Google API 返回的错误
            statusCode = error.response.status;
            if (error.response.data?.error?.message) {
                errorMessage = error.response.data.error.message;
            } else {
                errorMessage = `Google API 错误 (${statusCode})`;
            }
        } else if (error.code === 'ENOTFOUND') {
            errorMessage = '无法连接到 Google TTS 服务，请检查网络连接';
            statusCode = 503;
        } else if (error.code === 'ETIMEDOUT') {
            errorMessage = 'Google TTS 服务响应超时，请稍后重试';
            statusCode = 504;
        } else if (error.code === 'ECONNREFUSED') {
            errorMessage = '连接被拒绝，请检查网络设置';
            statusCode = 503;
        }
        
        return res.status(statusCode).json({ error: errorMessage });
    }
});

// 在现有代码后添加测试接口
app.get('/api/google-tts/test', async (req, res) => {
    try {
        const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'AIzaSyBdUuHIN43sgP9aQaUM7V25gHKymErH688';
        
        if (!GOOGLE_API_KEY) {
            return res.json({ 
                status: 'error', 
                message: 'Google API Key 未配置' 
            });
        }
        
        // 测试简单的TTS请求
        const testResponse = await axios.post(
            `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_API_KEY}`,
            {
                input: { text: "Hello" },
                voice: {
                    name: "en-US-Enceladus",
                    languageCode: "en-US"
                },
                audioConfig: {
                    audioEncoding: "LINEAR16"
                }
            },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000
            }
        );
        
        if (testResponse.status === 200 && testResponse.data.audioContent) {
            res.json({ 
                status: 'success', 
                message: 'Google TTS API 连接正常',
                keyPrefix: GOOGLE_API_KEY.substring(0, 10) + '...'
            });
        } else {
            res.json({ 
                status: 'error', 
                message: 'API 响应异常',
                response: testResponse.data
            });
        }
        
    } catch (error) {
        console.error('API 测试错误:', error.message);
        res.json({ 
            status: 'error', 
            message: error.message,
            code: error.code,
            responseStatus: error.response?.status
        });
    }
});

// 1. 新增：静态开放 taskaudio 文件夹
const taskAudioDir = path.join(__dirname, 'homework', 'taskaudio');
if (!fs.existsSync(taskAudioDir)) {
    fs.mkdirSync(taskAudioDir, { recursive: true });
}
app.use('/homework/taskaudio', express.static(taskAudioDir));

// 2. 新增：任务文本音频上传接口（变量名避免 audioStorage 冲突）
const taskAudioStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, taskAudioDir);
    },
    filename: function (req, file, cb) {
        // 保证文件名唯一（时间戳+原名）
        const ext = path.extname(file.originalname) || '.mp3';
        const base = path.basename(file.originalname, ext);
        const filename = `${Date.now()}_${base}${ext}`;
        cb(null, filename);
    }
});
const taskAudioUpload = multer({
    storage: taskAudioStorage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 限制文件大小为10MB
    fileFilter: function (req, file, cb) {
        const allowed = ['.mp3', '.wav', '.m4a', '.aac', '.ogg'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('仅支持mp3/wav/m4a/aac/ogg格式'));
    }
});
app.post('/api/task-audio-upload', taskAudioUpload.single('audio'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: '未收到音频文件' });
    }
    res.json({ success: true, filename: req.file.filename });
});

// 自动清理 taskaudio 目录下的音频文件，每15天执行一次
const TASKAUDIO_CLEAN_INTERVAL = 15 * 24 * 60 * 60 * 1000; // 15天

function cleanTaskAudioDir() {
    fs.readdir(taskAudioDir, (err, files) => {
        if (err) {
            console.error('[taskaudio清理] 读取目录失败:', err.message);
            return;
        }
        let deleted = 0;
        files.forEach(file => {
            const filePath = path.join(taskAudioDir, file);
            fs.unlink(filePath, err2 => {
                if (!err2) deleted++;
            });
        });
        if (files.length > 0) {
            console.log(`[taskaudio清理] 已删除 ${deleted}/${files.length} 个音频文件`);
        }
    });
}

// 启动时立即清理一次，然后每15天清理一次
setInterval(cleanTaskAudioDir, TASKAUDIO_CLEAN_INTERVAL);

// ...童行在线商城开始...
// 1. 卖家信息表
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS store_sellers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_login TEXT,
        info TEXT
    )`);
});

// 2. 卖家注册接口
app.post('/api/store/seller/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, error: '用户名和密码必填' });
    const now = new Date().toISOString();
    db.run(
        `INSERT INTO store_sellers (username, password, created_at) VALUES (?, ?, ?)`,
        [username, password, now],
        function (err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.json({ success: false, error: '用户名已存在' });
                }
                return res.status(500).json({ success: false, error: err.message });
            }
            // 简单登录态（可用cookie/session替换）
            res.cookie && res.cookie('store_seller', username, { httpOnly: true });
            res.json({ success: true, username });
        }
    );
});

// 3. 卖家登录接口
app.post('/api/store/seller/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, error: '用户名和密码必填' });
    db.get(
        `SELECT * FROM store_sellers WHERE username=? AND password=?`,
        [username, password],
        (err, row) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            if (!row) return res.json({ success: false, error: '用户名或密码错误' });
            db.run(`UPDATE store_sellers SET last_login=? WHERE username=?`, [new Date().toISOString(), username]);
            res.cookie && res.cookie('store_seller', username, { httpOnly: true });
            res.json({ success: true, username });
        }
    );
});

// 4. 检查卖家登录状态接口（前端可用localStorage或cookie存用户名）
app.get('/api/store/seller/check', (req, res) => {
    // 支持cookie或前端传username
    const username = req.cookies?.store_seller || req.query.username;
    if (!username) return res.json({ loggedIn: false });
    db.get(`SELECT * FROM store_sellers WHERE username=?`, [username], (err, row) => {
        if (err || !row) return res.json({ loggedIn: false });
        res.json({ loggedIn: true, username });
    });
});

// 5. 卖家退出接口
app.post('/api/store/seller/logout', (req, res) => {
    res.clearCookie && res.clearCookie('store_seller');
    res.json({ success: true });
});

// 6. 卖家信息保存/更新接口
app.post('/api/store/seller/save-info', (req, res) => {
    const { username, info } = req.body;
    if (!username) return res.status(400).json({ success: false, error: '缺少用户名' });
    db.run(
        `UPDATE store_sellers SET info=? WHERE username=?`,
        [JSON.stringify(info || {}), username],
        function (err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true });
        }
    );
});

// ...下面是童行在线商城商品相关...
// 1. 新建商品表 storeonline
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS storeonline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seller TEXT NOT NULL,           -- 卖家用户名
        name TEXT NOT NULL,             -- 商品名称
        category TEXT,                  -- 商品分类
        price REAL NOT NULL,            -- 价格
        stock INTEGER NOT NULL,         -- 库存
        main_image TEXT,                -- 主图URL或文件名
        detail_html TEXT,               -- 商品详情HTML
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        is_active INTEGER DEFAULT 1     -- 是否上架
    )`);
});

// 2. // 商品发布/修改接口（已支持新增和修改）
app.post('/api/storeonline/save', (req, res) => {
    const { id, seller, name, category, price, stock, main_image, detail_html, is_active } = req.body;
    if (!seller || !name || typeof price !== 'number' || typeof stock !== 'number') {
        return res.status(400).json({ error: '参数不完整' });
    }
    const now = new Date().toISOString();
    if (id) {
        // 修改商品
        db.run(
            `UPDATE storeonline SET name=?, category=?, price=?, stock=?, main_image=?, detail_html=?, updated_at=?, is_active=?
             WHERE id=? AND seller=?`,
            [name, category, price, stock, main_image, detail_html, now, is_active ? 1 : 0, id, seller],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, id });
            }
        );
    } else {
        // 新增商品
        db.run(
            `INSERT INTO storeonline (seller, name, category, price, stock, main_image, detail_html, created_at, updated_at, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [seller, name, category, price, stock, main_image, detail_html, now, now, is_active ? 1 : 0],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, id: this.lastID });
            }
        );
    }
});

// 3. 获取卖家自己的商品列表
app.get('/api/storeonline/my-products', (req, res) => {
    const { seller } = req.query;
    if (!seller) return res.status(400).json({ error: '缺少卖家用户名' });
    db.all(
        `SELECT * FROM storeonline WHERE seller=? ORDER BY updated_at DESC`,
        [seller],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// 4. 获取当前卖家所有商品（已存在，补充说明）
app.get('/api/storeonline/my-products', (req, res) => {
    const { seller } = req.query;
    if (!seller) return res.status(400).json({ error: '缺少卖家用户名' });
    db.all(
        `SELECT * FROM storeonline WHERE seller=? ORDER BY updated_at DESC`,
        [seller],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, products: rows || [] });
        }
    );
});

// 1. 获取所有商品（支持分类筛选）
app.get('/api/storeonline/products', (req, res) => {
    const { category } = req.query;
    let sql = `SELECT * FROM storeonline WHERE is_active=1`;
    const params = [];
    if (category) {
        sql += ` AND category=?`;
        params.push(category);
    }
    sql += ` ORDER BY updated_at DESC`;
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// 2. 获取所有商品分类标签（只返回有商品的分类）
app.get('/api/storeonline/categories', (req, res) => {
    db.all(
        `SELECT DISTINCT category FROM storeonline WHERE is_active=1 AND category IS NOT NULL AND category <> ''`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows.map(r => r.category));
        }
    );
});

// 5. 获取单个商品详情（buying.html用，已存在，补充说明）
app.get('/api/storeonline/product', (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: '缺少商品ID' });
    db.get(
        `SELECT * FROM storeonline WHERE id=?`,
        [id],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: '商品不存在' });
            res.json(row);
        }
    );
});

// 6. 商品上下架接口
app.post('/api/storeonline/set-active', (req, res) => {
    const { id, seller, is_active } = req.body;
    if (!id || !seller) return res.status(400).json({ error: '缺少参数' });
    db.run(
        `UPDATE storeonline SET is_active=?, updated_at=? WHERE id=? AND seller=?`,
        [is_active ? 1 : 0, new Date().toISOString(), id, seller],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// 7. 商品主图上传接口（可选，前端用FormData上传图片）
const storeImageDir = path.join(__dirname, 'storeonline', 'images');
if (!fs.existsSync(storeImageDir)) {
    fs.mkdirSync(storeImageDir, { recursive: true });
}
const storeImageUpload = multer({ storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, storeImageDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.jpg';
        const filename = `${Date.now()}_${Math.floor(Math.random()*10000)}${ext}`;
        cb(null, filename);
    }
})});
app.use('/storeonline/images', express.static(storeImageDir));
app.post('/api/storeonline/upload-image', storeImageUpload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: '未收到图片' });
    res.json({ success: true, filename: req.file.filename, url: `/storeonline/images/${req.file.filename}` });
});

// 新增：商品购买记录表
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS storeonline_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        buyer TEXT NOT NULL,
        seller TEXT,
        price REAL NOT NULL,
        pay_time TEXT NOT NULL,
        pay_info TEXT,
        status TEXT DEFAULT 'paid'
    )`);
});

// 新增：提交购买订单接口（只插入订单，不减少库存）
app.post('/api/storeonline/buy', (req, res) => {
    const { product_id, buyer, pay_info } = req.body;
    if (!product_id || !buyer) return res.status(400).json({ error: '缺少参数' });
    // 查询商品信息
    db.get(`SELECT * FROM storeonline WHERE id=?`, [product_id], (err, product) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!product) return res.status(404).json({ error: '商品不存在' });
        if (product.stock <= 0) return res.status(400).json({ error: '库存不足' });
        const now = new Date();
        const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
        db.run(
            `INSERT INTO storeonline_orders (product_id, buyer, seller, price, pay_time, pay_info, status)
             VALUES (?, ?, ?, ?, ?, ?, 'paid')`,
            [product_id, buyer, product.seller, product.price, beijingTime, pay_info || ''],
            function (err2) {
                if (err2) return res.status(500).json({ error: err2.message });
                // 不再减少库存，库存由卖家确认时减少
                res.json({ success: true, order_id: this.lastID });
            }
        );
    });
});

// 新增：卖家查询自己商品的订单
app.get('/api/storeonline/orders', (req, res) => {
    const { seller } = req.query;
    if (!seller) return res.status(400).json({ error: '缺少卖家用户名' });
    db.all(
        `SELECT * FROM storeonline_orders WHERE seller=? ORDER BY pay_time DESC`,
        [seller],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, orders: rows || [] });
        }
    );
});

// 删除商品及相关图片
app.post('/api/storeonline/delete-product', (req, res) => {
    const { id, seller } = req.body;
    if (!id || !seller) return res.status(400).json({ error: '缺少参数' });
    db.get(`SELECT * FROM storeonline WHERE id=? AND seller=?`, [id, seller], (err, product) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!product) return res.status(404).json({ error: '商品不存在' });

        // 收集主图和详情图片
        const imagesToDelete = [];
        if (product.main_image && product.main_image.startsWith('/storeonline/images/')) {
            imagesToDelete.push(path.join(__dirname, product.main_image));
        }
        // 解析详情HTML中的图片
        if (product.detail_html) {
            try {
                const $ = cheerio.load(product.detail_html);
                $('img').each((i, el) => {
                    const src = $(el).attr('src');
                    if (src && src.startsWith('/storeonline/images/')) {
                        imagesToDelete.push(path.join(__dirname, src));
                    }
                });
            } catch {}
        }

        // 删除数据库记录
        db.run(`DELETE FROM storeonline WHERE id=? AND seller=?`, [id, seller], function (err2) {
            if (err2) return res.status(500).json({ error: err2.message });

            // 删除图片文件
            imagesToDelete.forEach(imgPath => {
                fs.unlink(imgPath, () => {});
            });

            res.json({ success: true });
        });
    });
});

// 新增：卖家确认卖出接口（批量确认订单并减少库存）
app.post('/api/storeonline/confirm-sell', (req, res) => {
    const { seller, orderIds } = req.body;
    if (!seller || !Array.isArray(orderIds) || orderIds.length === 0) {
        return res.status(400).json({ success: false, error: '参数不完整' });
    }
    // 查询所有待确认订单
    db.all(
        `SELECT * FROM storeonline_orders WHERE id IN (${orderIds.map(() => '?').join(',')}) AND seller=? AND status='paid'`,
        [...orderIds, seller],
        (err, orders) => {
            if (err) return res.status(500).json({ success: false, error: '数据库错误' });
            if (!orders || orders.length === 0) return res.json({ success: false, error: '无待确认订单' });

            let updated = 0;
            let failed = [];
            let pending = orders.length;

            orders.forEach(order => {
                // 减库存
                db.run(
                    `UPDATE storeonline SET stock = stock - 1 WHERE id = ? AND seller = ? AND stock > 0`,
                    [order.product_id, seller],
                    function (err2) {
                        if (err2 || this.changes === 0) {
                            failed.push(order.id);
                        } else {
                            // 更新订单状态
                            db.run(
                                `UPDATE storeonline_orders SET status='confirmed' WHERE id=?`,
                                [order.id],
                                function (err3) {
                                    if (!err3) updated++;
                                    // 完成后返回
                                    if (--pending === 0) {
                                        res.json({
                                            success: true,
                                            confirmed: updated,
                                            failed
                                        });
                                    }
                                }
                            );
                            return;
                        }
                        // 完成后返回
                        if (--pending === 0) {
                            res.json({
                                success: true,
                                confirmed: updated,
                                failed
                            });
                        }
                    }
                );
            });
        }
    );
});

// 新增：删除商城订单记录接口（支持批量删除）
app.post('/api/storeonline/delete-orders', (req, res) => {
    const { seller, orderIds } = req.body;
    if (!seller || !Array.isArray(orderIds) || orderIds.length === 0) {
        return res.status(400).json({ success: false, error: '参数不完整' });
    }
    // 只允许删除属于自己的订单
    const placeholders = orderIds.map(() => '?').join(',');
    db.run(
        `DELETE FROM storeonline_orders WHERE id IN (${placeholders}) AND seller=?`,
        [...orderIds, seller],
        function (err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, deleted: this.changes });
        }
    );
});
// ...童行在线商城结束...

// ...语法训练记录表开始...
// 1. 初始化语法训练记录表 grammer
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS grammer (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        grade TEXT NOT NULL,
        unit TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        correct_count INTEGER NOT NULL,
        total_count INTEGER NOT NULL,
        wrong_sentences TEXT NOT NULL, -- JSON数组：[ {cn, en} ]
        user_answers TEXT DEFAULT '[]' -- 新增：JSON 字符串，保存用户作答内容
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_grammer_user_grade_unit_date ON grammer(username, grade, unit, date)`);
});

// 修复：自动为 grammer 表添加 user_answers 字段（兼容旧数据库）
db.serialize(() => {
    db.run(`ALTER TABLE grammer ADD COLUMN user_answers TEXT DEFAULT '[]'`, () => {});
});

// 2. 上报语法训练结果接口
app.post('/api/grammer/record', (req, res) => {
    const { username, grade, unit, date, time, correct_count, total_count, wrong_sentences, user_answers } = req.body;
    if (!username || !grade || !unit || !date || !time || typeof correct_count !== 'number' || typeof total_count !== 'number' || !Array.isArray(wrong_sentences)) {
        return res.status(400).json({ error: '参数不完整' });
    }
    const wrongJson = JSON.stringify(wrong_sentences || []);
    const answersJson = JSON.stringify(Array.isArray(user_answers) ? user_answers : []);
    db.run(
        `INSERT INTO grammer (username, grade, unit, date, time, correct_count, total_count, wrong_sentences, user_answers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [username, grade, unit, date, time, correct_count, total_count, wrongJson, answersJson],
        function(err) {
            if (err) {
                console.error('插入 grammer 记录失败', err);
                return res.status(500).json({ success: false, error: '数据库写入失败' });
            }

            // 保持最近200条记录（按时间降序），多余的自动删除（原逻辑保持）
            db.all(
                `SELECT id FROM grammer WHERE username=? AND grade=? AND unit=? ORDER BY date DESC, time DESC`,
                [username, grade, unit],
                (err2, rows) => {
                    if (!err2 && Array.isArray(rows) && rows.length > 200) {
                        const keep = rows.slice(0,200).map(r => r.id);
                        const placeholders = keep.map(() => '?').join(',');
                        // 删除 id 不在 keep 列表的多余记录
                        db.run(`DELETE FROM grammer WHERE username=? AND grade=? AND unit=? AND id NOT IN (${placeholders})`,
                            [username, grade, unit, ...keep], function(delErr){});
                    }
                }
            );

            res.json({ success: true, id: this.lastID });
        }
    );
});

// 3. 查询语法训练记录接口（支持按用户名、年级、单元筛选）
app.get('/api/grammer/records', (req, res) => {
    const { username, grade, unit } = req.query;
    let sql = `SELECT * FROM grammer WHERE 1=1`;
    const params = [];
    if (username) { sql += ` AND username=?`; params.push(username); }
    if (grade) { sql += ` AND grade=?`; params.push(grade); }
    if (unit) { sql += ` AND unit=?`; params.push(unit); }
    sql += ` ORDER BY date DESC, time DESC`;
    db.all(sql, params, (err, rows) => {
        if (err) {
            console.error('查询 grammer 记录出错', err);
            return res.json([]);
        }
        const result = (rows || []).map(r => {
            let wrong = [];
            let answers = [];
            try { wrong = JSON.parse(r.wrong_sentences || '[]'); } catch(e) { wrong = []; }
            try { answers = JSON.parse(r.user_answers || '[]'); } catch(e) { answers = []; }
            return {
                ...r,
                wrong_sentences: wrong,
                user_answers: answers
            };
        });
        res.json(result);
    });
});

// 4. 删除语法训练记录接口（支持按id或按用户名/年级/单元批量删除）
app.post('/api/grammer/delete', (req, res) => {
    const { id, username, grade, unit } = req.body;
    let sql = `DELETE FROM grammer WHERE `;
    const params = [];
    if (id) {
        sql += `id=?`;
        params.push(id);
    } else {
        const conds = [];
        if (username) { conds.push('username=?'); params.push(username); }
        if (grade) { conds.push('grade=?'); params.push(grade); }
        if (unit) { conds.push('unit=?'); params.push(unit); }
        if (conds.length === 0) return res.status(400).json({ error: '缺少删除条件' });
        sql += conds.join(' AND ');
    }
    db.run(sql, params, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, deleted: this.changes });
    });
});
// ...语法训练记录表结束...

// ===== 线下学员交费与课消系统（feesystem 单表）开始 =====
//   单表多类型设计：
//   record_type: 'user' | 'payment' | 'course' | 'enroll' | 'lesson_consume' | 'lesson_adjust' | 'course_finish'
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS feesystem (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_type TEXT NOT NULL,
        username TEXT,
        user_id TEXT,
        password TEXT,
        is_admin INTEGER DEFAULT 0,
        is_teacher INTEGER DEFAULT 0,
        balance REAL,
        payment_amount REAL,
        payment_time TEXT,
        course_id TEXT,
        course_name TEXT,
        total_lessons INTEGER,
        course_status TEXT,
        teacher_username TEXT,
        lesson_price REAL,
        remaining_lessons INTEGER,
        remaining_fee REAL,
        consume_change INTEGER,
        consume_time TEXT,
        remark TEXT,
        -- 新增：费用属性及其总课次/剩余课次（适用于 record_type='user' 表示用户当前属性；record_type='payment' 也可记录当次付款属性）
        fee_attribute TEXT,                   -- '普通' | '小学两期优惠' | '初中两期优惠' | '小学课包' | '初中课包'
        fee_attr_total_lessons INTEGER,
        fee_attr_remaining_lessons INTEGER,
        created_at TEXT,
        updated_at TEXT
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_feesystem_type ON feesystem(record_type)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_feesystem_user ON feesystem(username)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_feesystem_course ON feesystem(course_id)`);
});

// 兼容：若已有数据库缺少新列，尝试添加（忽略错误）
db.serialize(() => {
    try { db.run(`ALTER TABLE feesystem ADD COLUMN fee_attribute TEXT`, ()=>{}); } catch(e) {}
    try { db.run(`ALTER TABLE feesystem ADD COLUMN fee_attr_total_lessons INTEGER`, ()=>{}); } catch(e) {}
    try { db.run(`ALTER TABLE feesystem ADD COLUMN fee_attr_remaining_lessons INTEGER`, ()=>{}); } catch(e) {}
    // 新增：添加 fee_attrs 字段用于存储多属性费用配置
    try { db.run(`ALTER TABLE feesystem ADD COLUMN fee_attrs TEXT`, ()=>{}); } catch(e) {}
});

// 工具函数
function nowISO() { return new Date().toISOString(); }
function respondError(res, msg) { res.status(400).json({ success: false, error: msg }); }

// ========== 用户管理 ==========
// 工具：在 feesystem 内生成 TX+三位顺序号，回收已删除 ID（返回第一个空缺或下一序号）
function generateFeeUserId(callback) {
    db.all(
        `SELECT user_id FROM feesystem WHERE record_type='user' AND user_id IS NOT NULL AND user_id <> ''`,
        [],
        (err, rows) => {
            if (err) return callback(err);
            const used = new Set();
            (rows || []).forEach(r => {
                const v = (r.user_id || '').toString().trim();
                const m = v.match(/^TX0*([0-9]+)$/i);
                if (m) {
                    const n = parseInt(m[1], 10);
                    if (!isNaN(n) && n >= 1) used.add(n);
                }
            });
            // 找最小可用正整数序号（从1开始）
            let i = 1;
            while (used.has(i)) i++;
            const seqStr = String(i).padStart(3, '0');
            callback(null, `TX${seqStr}`);
        }
    );
}

// 新增：提供前端预取 user_id 的接口（userinfo.html 会调用）
app.get('/api/fee/generate-userid', (req, res) => {
    generateFeeUserId((err, userId) => {
        if (err) return res.status(500).json({ success: false, error: err.message || '生成 user_id 失败' });
        res.json({ success: true, user_id: userId });
    });
});

// ===== 修改：/api/fee/users 返回包含每个用户所有属性余额（兼容旧字段） =====
app.get('/api/fee/users', (req, res) => {
    db.all(
        `SELECT id, user_id, username, is_admin, is_teacher, password FROM feesystem WHERE record_type='user' ORDER BY id ASC`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json([]);
            if (!rows || rows.length === 0) return res.json([]);
            // for each user, load balances
            const users = [];
            let pending = rows.length;
            rows.forEach(u => {
                db.all(`SELECT fee_attribute, balance, fee_attr_total_lessons, fee_attr_remaining_lessons FROM fee_balances WHERE username=? ORDER BY fee_attribute`,
                    [u.username], (e, bals) => {
                        const balances = (bals||[]).map(b=>({
                            fee_attribute: b.fee_attribute,
                            balance: Number(b.balance||0),
                            fee_attr_total_lessons: b.fee_attr_total_lessons === null ? undefined : Number(b.fee_attr_total_lessons),
                            fee_attr_remaining_lessons: b.fee_attr_remaining_lessons === null ? undefined : Number(b.fee_attr_remaining_lessons)
                        }));
                        const total = balances.reduce((s,b)=> s + (Number(b.balance)||0), 0);
                        users.push({
                            id: u.id,
                            user_id: u.user_id || '',
                            username: u.username,
                            is_admin: u.is_admin,
                            is_teacher: u.is_teacher,
                            password: u.password,
                            balance: Math.round(total*100)/100,
                            // 保持兼容旧字段（选取第一个非普通属性或普通）
                            fee_attribute: balances.length ? balances[0].fee_attribute : '普通',
                            fee_attr_total_lessons: balances.length ? balances[0].fee_attr_total_lessons : null,
                            fee_attr_remaining_lessons: balances.length ? balances[0].fee_attr_remaining_lessons : null,
                            balances // detailed list
                        });
                        pending--;
                        if (pending === 0) {
                            res.json(users);
                        }
                    });
            });
        });
});

// 新增用户：不再写入 age/school/contact
app.post('/api/fee/user/add', (req, res) => {
    const {
        username,
        password = '000000',
        is_admin = 0,
        is_teacher = 0,
        user_id: providedUserId
    } = req.body;

    if (!username) return respondError(res, '缺少用户名');

    db.get(`SELECT 1 FROM feesystem WHERE record_type='user' AND username=?`, [username], (err, row) => {
        if (err) return respondError(res, '查询失败');
        if (row) return respondError(res, '用户名已存在');

        const insertWithUserId = (finalUserId) => {
            const ts = nowISO();
            db.run(
                `INSERT INTO feesystem (record_type, user_id, username, password, is_admin, is_teacher, balance, created_at, updated_at)
                VALUES ('user', ?, ?, ?, ?, ?, 0, ?, ?)`,
                [finalUserId || '', username, password, is_admin ? 1 : 0, is_teacher ? 1 : 0, ts, ts],
                function (err2) {
                    if (err2) return respondError(res, '新增失败: ' + (err2.message || ''));
                    const insertedId = this.lastID;
                    db.get(`SELECT user_id FROM feesystem WHERE id = ?`, [insertedId], (err3, row) => {
                        if (err3) {
                            return res.json({ success: true, id: insertedId, user_id: finalUserId || '' });
                        }
                        res.json({ success: true, id: insertedId, user_id: row?.user_id || (finalUserId || '') });
                    });
                }
            );
        };

        if (providedUserId) {
            const v = String(providedUserId).trim().toUpperCase();
            if (!/^TX\d{3}$/.test(v)) return respondError(res, '提供的 user_id 格式无效，需为 TXNNN');
            db.get(`SELECT 1 FROM feesystem WHERE user_id = ?`, [v], (e, r) => {
                if (e) return respondError(res, '查询失败');
                if (r) return respondError(res, 'user_id 已被占用');
                insertWithUserId(v);
            });
        } else {
            generateFeeUserId((gerr, genId) => {
                if (gerr) return respondError(res, '生成 user_id 失败');
                insertWithUserId(genId);
            });
        }
    });
});
// ...existing code...
// 更新用户（仅支持修改 password，已移除 age/school/contact 更新）
app.post('/api/fee/user/update', (req, res) => {
    const { username, password } = req.body;
    if (!username) return respondError(res, '缺少用户名');
    const fields = [];
    const params = [];
    if (password !== undefined) { fields.push('password=?'); params.push(password); }
    if (fields.length === 0) return respondError(res, '无可更新字段');
    fields.push('updated_at=?'); params.push(nowISO());
    params.push(username);
    db.run(
        `UPDATE feesystem SET ${fields.join(',')} WHERE record_type='user' AND username=?`,
        params,
        function (err) {
            if (err) return respondError(res, '更新失败');
            if (this.changes === 0) return respondError(res, '用户不存在');
            res.json({ success: true });
        }
    );
});

// 设置管理员 / 老师（批量）
app.post('/api/fee/user/set-role', (req, res) => {
    const { usernames, is_admin, is_teacher } = req.body;
    if (!Array.isArray(usernames) || usernames.length === 0)
        return respondError(res, '缺少用户列表');
    const sets = [];
    const params = [];
    if (is_admin !== undefined) { sets.push('is_admin=?'); params.push(is_admin ? 1 : 0); }
    if (is_teacher !== undefined) { sets.push('is_teacher=?'); params.push(is_teacher ? 1 : 0); }
    if (sets.length === 0) return respondError(res, '无可更新字段');
    sets.push('updated_at=?'); params.push(nowISO());
    const placeholders = usernames.map(() => '?').join(',');
    params.push(...usernames);
    db.run(
        `UPDATE feesystem SET ${sets.join(',')} WHERE record_type='user' AND username IN (${placeholders})`,
        params,
        function (err) {
            if (err) return respondError(res, '更新失败');
            res.json({ success: true, changed: this.changes });
        }
    );
});

// 删除用户（彻底删除所有相关信息）
app.post('/api/fee/user/delete', (req, res) => {
    const { username } = req.body;
    if (!username) return respondError(res, '缺少用户名');
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        // 1. 删除 feesystem 表中所有该用户相关记录（包括 user、enroll、payment、lesson_consume、lesson_adjust、course_finish 等）
        db.run(`DELETE FROM feesystem WHERE username=?`, [username]);
        // 2. 删除 fee_balances 表中该用户所有属性余额
        db.run(`DELETE FROM fee_balances WHERE username=?`, [username]);
        // 3. 可选：如有其它相关表（如报名、签到、其它自定义表），也可一并删除
        db.run('COMMIT', (err) => {
            if (err) return respondError(res, '删除失败: ' + err.message);
            res.json({ success: true });
        });
    });
});

// ========== 交费系统 ==========
// ===== 新增：多属性余额表（fee_balances） =====
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS fee_balances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        fee_attribute TEXT NOT NULL DEFAULT '普通',
        balance REAL NOT NULL DEFAULT 0,
        fee_attr_total_lessons INTEGER,
        fee_attr_remaining_lessons INTEGER,
        updated_at TEXT
    )`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_balances_user_attr ON fee_balances(username, fee_attribute)`);
});

// 兼容迁移：如果旧的 feesystem.user 行里包含 fee_attribute/fee_attr_remaining_lessons 等，尝试迁移到 fee_balances（幂等）
function migrateFeeBalancesIfNeeded() {
    db.all(`SELECT username, fee_attribute, balance, fee_attr_total_lessons, fee_attr_remaining_lessons 
            FROM feesystem WHERE record_type='user'`, [], (err, rows) => {
        if (err || !rows || !rows.length) return;
        rows.forEach(r => {
            const username = r.username;
            const attr = (r.fee_attribute || '普通').toString() || '普通';
            const bal = typeof r.balance === 'number' ? r.balance : (parseFloat(r.balance) || 0);
            const total = (r.fee_attr_total_lessons !== undefined && r.fee_attr_total_lessons !== null) ? Number(r.fee_attr_total_lessons) : null;
            const remain = (r.fee_attr_remaining_lessons !== undefined && r.fee_attr_remaining_lessons !== null) ? Number(r.fee_attr_remaining_lessons) : null;
            const now = new Date().toISOString();

            // 仅在 fee_balances 中不存在该记录时才插入（避免覆盖已有数据）
            db.get(`SELECT id FROM fee_balances WHERE username=? AND fee_attribute=?`, [username, attr], (e, row) => {
                if (e) return;
                if (row) {
                    // 如果目标已存在，则跳过，不做覆盖，避免把已有数据清空
                    return;
                } else {
                    db.run(`INSERT INTO fee_balances (username, fee_attribute, balance, fee_attr_total_lessons, fee_attr_remaining_lessons, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
                        [username, attr, bal, total, remain, now]);
                }
            });
        });
    });
}
migrateFeeBalancesIfNeeded();

// ===== 新接口：查询单个用户所有属性余额及总和 =====
app.get('/api/fee/user/balances', (req, res) => {
    const username = req.query.username;
    if (!username) return res.status(400).json({ success:false, error:'username required' });
    db.all(`SELECT fee_attribute, balance, fee_attr_total_lessons, fee_attr_remaining_lessons, updated_at
            FROM fee_balances WHERE username=? ORDER BY fee_attribute`, [username], (err, rows) => {
        if (err) return res.status(500).json({ success:false, error: err.message });
        const balances = (rows||[]).map(r=>({
            fee_attribute: r.fee_attribute,
            balance: Number(r.balance||0),
            fee_attr_total_lessons: r.fee_attr_total_lessons === null ? undefined : Number(r.fee_attr_total_lessons),
            fee_attr_remaining_lessons: r.fee_attr_remaining_lessons === null ? undefined : Number(r.fee_attr_remaining_lessons),
            updated_at: r.updated_at
        }));
        const total = balances.reduce((s,b)=> s + (Number(b.balance)||0), 0);
        res.json({ success:true, username, totalBalance: Math.round(total*100)/100, balances });
    });
});



// 交费（增加余额并记录 payment）—— 支持 fee_attribute 与 fee_attr_total_lessons 参数
app.post('/api/fee/payment', (req, res) => {
    const { username, amount, remark = '', fee_attribute = '普通', fee_attr_total_lessons } = req.body;
    if (!username || typeof amount !== 'number') return respondError(res, '参数缺失或类型错误');
    if (amount <= 0) return respondError(res, '金额需大于0');

    const normalizedAttr = (fee_attribute || '').toString().trim() || '普通';
    const ts = nowISO();

    // 修改：普通属性允许总课次为0，其它属性需为正数
    if (fee_attribute === '普通') {
        if (fee_attr_total_lessons === undefined || isNaN(Number(fee_attr_total_lessons)) || Number(fee_attr_total_lessons) < 0) {
            return res.json({ success: false, error: '普通属性总课次允许为0或正数' });
        }
    } else {
        if (!fee_attr_total_lessons || isNaN(Number(fee_attr_total_lessons)) || Number(fee_attr_total_lessons) <= 0) {
            return res.json({ success: false, error: '总课次必填且需为正数' });
        }
    }

    // 同步写入/更新 fee_balances 表
    db.get(`SELECT id, balance, fee_attr_total_lessons, fee_attr_remaining_lessons FROM fee_balances WHERE username=? AND fee_attribute=?`, [username, normalizedAttr], (err, balRow) => {
        let newBalance = amount;
        let totalLessons = Number(fee_attr_total_lessons);
        let remainLessons = totalLessons;
        if (balRow) {
            newBalance = Math.round((Number(balRow.balance || 0) + amount) * 100) / 100;
            // 累加课次
            const existingTotal = Number(balRow.fee_attr_total_lessons || 0);
            const existingRemain = Number(balRow.fee_attr_remaining_lessons || 0);
            totalLessons = existingTotal + totalLessons;
            remainLessons = existingRemain + remainLessons;
        }

        function insertPaymentRecord() {
            db.run(
                `INSERT INTO feesystem (record_type, username, payment_amount, payment_time, remark, fee_attribute, fee_attr_total_lessons, created_at, updated_at)
                 VALUES ('payment', ?, ?, ?, ?, ?, ?, ?, ?)`,
                [username, amount, ts, remark, normalizedAttr, Number(fee_attr_total_lessons), ts, ts],
                function (err3) {
                    if (err3) return respondError(res, '记录交费失败');
                    // 更新 feesystem.user 行的总余额
                    db.get(`SELECT SUM(balance) as total FROM fee_balances WHERE username=?`, [username], (se, sumRow) => {
                        const total = sumRow ? Number(sumRow.total||0) : 0;
                        db.run(`UPDATE feesystem SET balance=? WHERE record_type='user' AND username=?`, [total, username], ()=>{});
                        res.json({ success: true, new_balance: Math.round(newBalance * 100) / 100 });
                    });
                }
            );
        }

        if (balRow) {
            db.run(
                `UPDATE fee_balances SET balance=?, fee_attr_total_lessons=?, fee_attr_remaining_lessons=?, updated_at=? WHERE id=?`,
                [Math.round(newBalance * 100) / 100, totalLessons, remainLessons, ts, balRow.id],
                function (err2) {
                    if (err2) return respondError(res, '更新余额失败');
                    insertPaymentRecord();
                }
            );
        } else {
            db.run(
                `INSERT INTO fee_balances (username, fee_attribute, balance, fee_attr_total_lessons, fee_attr_remaining_lessons, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [username, normalizedAttr, Math.round(newBalance * 100) / 100, totalLessons, remainLessons, ts],
                function (err2) {
                    if (err2) return respondError(res, '创建余额记录失败');
                    insertPaymentRecord();
                }
            );
        }
    });
});

// 新增：扣费接口
app.post('/api/fee/deduct', (req, res) => {
    const { username, amount, fee_attribute, remark } = req.body;
    if (!username || typeof amount !== 'number' || !fee_attribute)
        return respondError(res, '参数缺失或类型错误');
    if (amount <= 0) return respondError(res, '扣费金额需大于0');
    const attr = (fee_attribute || '').trim() || '普通';
    const ts = nowISO();
    // 查询余额
    db.get(`SELECT id, balance FROM fee_balances WHERE username=? AND fee_attribute=?`, [username, attr], (err, balRow) => {
        if (err) return respondError(res, '数据库错误');
        if (!balRow) return respondError(res, '未找到该属性余额');
        if (Number(balRow.balance) < amount) return respondError(res, '余额不足');
        const newBalance = Number(balRow.balance) - amount;
        db.run(`UPDATE fee_balances SET balance=?, updated_at=? WHERE id=?`, [newBalance, ts, balRow.id], function (err2) {
            if (err2) return respondError(res, '扣费失败');
            // 记录一条 payment 记录，金额为负
            db.run(
                `INSERT INTO feesystem (record_type, username, payment_amount, payment_time, fee_attribute, remark, created_at, updated_at)
                 VALUES ('payment', ?, ?, ?, ?, ?, ?, ?)`,
                [username, -amount, ts, attr, remark || '其他扣费', ts, ts],
                function (err3) {
                    if (err3) return respondError(res, '扣费记录失败');
                    res.json({ success: true, new_balance: newBalance });
                }
            );
        });
    });
});

// ===== 修改：/api/fee/user/set-balance 以按属性保存并支持合并 =====
app.post('/api/fee/user/set-balance', (req, res) => {
    const { username, balance, fee_attribute, fee_attr_total_lessons, fee_attr_remaining_lessons, balances } = req.body;

    if (!username) {
        return respondError(res, '用户名必填');
    }

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        const processBalance = (bal, attr, total, remain, cb) => {
            if (bal === undefined) return cb();

            db.get('SELECT 1 FROM fee_balances WHERE username = ? AND fee_attribute = ?', [username, attr], (err, row) => {
                if (err) return cb(err);
                const finalRemain = (remain !== undefined && remain !== null) ? remain : null;
                const finalTotal = (total !== undefined && total !== null) ? total : null;

                if (row) { // Update
                    db.run(
                        `UPDATE fee_balances SET balance = ?, fee_attr_total_lessons = ?, fee_attr_remaining_lessons = ? WHERE username = ? AND fee_attribute = ?`,
                        [bal, finalTotal, finalRemain, username, attr],
                        cb
                    );
                } else { // Insert
                    db.run(
                        `INSERT INTO fee_balances (username, fee_attribute, balance, fee_attr_total_lessons, fee_attr_remaining_lessons) VALUES (?, ?, ?, ?, ?)`,
                        [username, attr, bal, finalTotal, finalRemain],
                        cb
                    );
                }
            });
        };

        let tasks = [];
        if (Array.isArray(balances)) {
            balances.forEach(item => {
                tasks.push(cb => processBalance(item.balance, item.fee_attribute, item.fee_attr_total_lessons, item.fee_attr_remaining_lessons, cb));
            });
        } else if (balance !== undefined) {
            tasks.push(cb => processBalance(balance, fee_attribute || '普通', fee_attr_total_lessons, fee_attr_remaining_lessons, cb));
        }

        if (tasks.length === 0) {
            db.run('ROLLBACK');
            return respondError(res, '无有效余额数据');
        }

        let completed = 0;
        tasks.forEach(task => {
            task(err => {
                if (err) {
                    db.run('ROLLBACK');
                    return respondError(res, '数据库操作失败: ' + err.message);
                }
                completed++;
                if (completed === tasks.length) {
                    db.run('COMMIT', (commitErr) => {
                        if (commitErr) return respondError(res, '数据库提交失败: ' + commitErr.message);
                        res.json({ success: true });
                    });
                }
            });
        });
    });
});

// 查询交费记录
app.get('/api/fee/payments', (req, res) => {
    const { username } = req.query;
    const params = [];
    let where = `WHERE record_type='payment'`;
    if (username) { where += ' AND username=?'; params.push(username); }
    db.all(
        // 增加 fee_attribute 字段
        `SELECT id, username, payment_amount, payment_time, remark, fee_attribute FROM feesystem ${where} ORDER BY payment_time DESC`,
        params,
        (err, rows) => {
            if (err) return res.json([]);
            res.json(rows || []);
        }
    );
});

// -- 导出交费记录为 CSV开始 --
app.get('/api/fee/export-payments-csv', (req, res) => {
    db.all(
        `SELECT u.user_id, u.username, p.fee_attribute, p.payment_amount, p.payment_time, p.remark
         FROM feesystem p
         LEFT JOIN feesystem u ON u.username=p.username AND u.record_type='user'
         WHERE p.record_type='payment'
         ORDER BY p.payment_time DESC`,
        [],
        (err, rows) => {
            if (err) return res.status(500).send('数据库错误');
            const header = ['学生ID','学生姓名','费用属性','金额','日期时间','收费人','扣费备注'];
            const lines = [header.join(',')];
            rows.forEach(r => {
                // 金额>0为交费，金额<0为扣费
                const payPerson = Number(r.payment_amount) > 0 ? (r.remark || '') : '';
                const deductRemark = Number(r.payment_amount) < 0 ? (r.remark || '') : '';
                lines.push([
                    r.user_id || '',
                    r.username || '',
                    r.fee_attribute || '',
                    r.payment_amount || '',
                    r.payment_time || '',
                    payPerson,
                    deductRemark
                ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
            });
            res.setHeader('Content-Type','text/csv; charset=UTF-8');
            res.setHeader('Content-Disposition','attachment; filename=fee_payments.csv');
            res.send('\uFEFF' + lines.join('\r\n'));
        }
    );
});
// -- 导出交费记录为 CSV结束 --
// -- 导入交费记录自 CSV开始 --
app.post('/api/fee/import-payments-csv', multerMemory.single('file'), async (req, res) => {
    try {
        const text = req.file && req.file.buffer ? req.file.buffer.toString('utf8') : '';
        if (!text) return res.json({ success: false, error: '未收到文件内容' });
        // 简单CSV解析
        const rows = text.split(/\r?\n/).map(line => line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(s => s.replace(/^"|"$/g, '').replace(/""/g,'"')));
        if (rows.length < 2) return res.json({ success: false, error: '无有效数据' });
        let processed = 0;
        for (let i = 1; i < rows.length; i++) {
            const [user_id, username, fee_attribute, amount, payment_time, pay_person, deduct_remark] = rows[i];
            if (!username || !amount) continue;
            const amt = parseFloat(amount);
            if (!amt || isNaN(amt)) continue;
            const remark = amt > 0 ? (pay_person || '') : (deduct_remark || '');
            // 插入交费/扣费记录
            db.run(`INSERT INTO feesystem (record_type, username, payment_amount, payment_time, remark, fee_attribute, created_at, updated_at)
                    VALUES ('payment', ?, ?, ?, ?, ?, ?, ?)`,
                [username, amt, payment_time || null, remark, fee_attribute || '', new Date().toISOString(), new Date().toISOString()]);
            // 同步更新 fee_balances
            db.get(`SELECT id, balance FROM fee_balances WHERE username=? AND fee_attribute=?`, [username, fee_attribute || '普通'], (err, balRow) => {
                let newBalance = amt;
                if (balRow) {
                    newBalance = Math.round((Number(balRow.balance || 0) + amt) * 100) / 100;
                    db.run(`UPDATE fee_balances SET balance=?, updated_at=? WHERE id=?`, [newBalance, new Date().toISOString(), balRow.id]);
                } else {
                    db.run(`INSERT INTO fee_balances (username, fee_attribute, balance, updated_at) VALUES (?, ?, ?, ?)`,
                        [username, fee_attribute || '普通', newBalance, new Date().toISOString()]);
                }
            });
            processed++;
        }
        res.json({ success: true, processed });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});
// -- 导入交费记录自 CSV结束 --
// ========== 课程管理 ========== 

// 添加课程
app.post('/api/fee/course/add', (req, res) => {
    const { course_id, course_name, total_lessons, teacher_username = '', lesson_price = 0 } = req.body;
    if (!course_id || !course_name || typeof total_lessons !== 'number')
        return respondError(res, '参数不完整');
    db.get(`SELECT 1 FROM feesystem WHERE record_type='course' AND course_id=?`, [course_id], (err, row) => {
        if (err) return respondError(res, '查询失败');
        if (row) return respondError(res, '课程ID已存在');
        const ts = nowISO();
        // 默认 course_status 为空（未开课），仅调用开课接口时设置为 'open'
        db.run(
            `INSERT INTO feesystem (
                record_type, course_id, course_name, total_lessons,
                teacher_username, course_status, lesson_price, created_at, updated_at
            ) VALUES ('course', ?, ?, ?, ?, ?, ?, ?, ?)`,
            [course_id, course_name, total_lessons, teacher_username, '', lesson_price, ts, ts],
            function (err2) {
                if (err2) return respondError(res, '新增失败');
                res.json({ success: true, id: this.lastID });
            }
        );
    });
});

// 修改课程
app.post('/api/fee/course/update', (req, res) => {
    const { course_id, course_name, total_lessons, teacher_username, lesson_price, course_status } = req.body;
    if (!course_id) return respondError(res, '缺少课程ID');
    const sets = [];
    const params = [];
    if (course_name !== undefined) { sets.push('course_name=?'); params.push(course_name); }
    if (total_lessons !== undefined) { sets.push('total_lessons=?'); params.push(total_lessons); }
    if (teacher_username !== undefined) { sets.push('teacher_username=?'); params.push(teacher_username); }
    if (lesson_price !== undefined) { sets.push('lesson_price=?'); params.push(lesson_price); }
    // 新增：允许更新 course_status（可设置为空字符串表示未开课）
    if (course_status !== undefined) { sets.push('course_status=?'); params.push(course_status); }
    if (sets.length === 0) return respondError(res, '无可更新字段');
    sets.push('updated_at=?'); params.push(nowISO());
    params.push(course_id);
    db.run(
        `UPDATE feesystem SET ${sets.join(',')} WHERE record_type='course' AND course_id=?`,
        params,
        function (err) {
            if (err) return respondError(res, '更新失败');
            if (this.changes === 0) return respondError(res, '课程不存在');
            res.json({ success: true });
        }
    );
});

// 删除课程（改为事务性级联删除，同时阻止删除处于开课状态的课程）
app.post('/api/fee/course/delete', (req, res) => {
    const { course_id } = req.body;
    if (!course_id) return respondError(res, '缺少课程ID');

    // 先查询课程状态（若存在），禁止删除处于开课状态的课程
    db.get(`SELECT course_status FROM feesystem WHERE record_type='course' AND course_id=?`, [course_id], (err, row) => {
        if (err) {
            console.error('查询课程状态失败', err);
            return res.status(500).json({ success: false, error: '查询失败' });
        }

        if (row && row.course_status === 'open') {
            return respondError(res, '课程处于开课状态，无法删除');
        }

        // 事务：删除所有与该 course_id 相关的记录（course / enroll / lesson_consume / lesson_adjust / course_finish 等）
        db.run('BEGIN TRANSACTION', (beginErr) => {
            if (beginErr) {
                console.error('开始事务失败', beginErr);
                return res.status(500).json({ success: false, error: '开始事务失败' });
            }

            db.run(`DELETE FROM feesystem WHERE course_id = ?`, [course_id], function(deleteErr) {
                if (deleteErr) {
                    console.error('删除课程相关记录失败', deleteErr);
                    return db.run('ROLLBACK', () => {
                        respondError(res, '删除失败');
                    });
                }

                const deleted = this.changes || 0;

                db.run('COMMIT', (commitErr) => {
                    if (commitErr) {
                        console.error('提交事务失败', commitErr);
                        return db.run('ROLLBACK', () => {
                            respondError(res, '删除提交失败');
                        });
                    }
                    res.json({ success: true, deleted });
                });
            });
        });
    });
});

// 开课（如果已结课则不允许重新开课）
app.post('/api/fee/course/open', (req, res) => {
    const { course_id } = req.body;
    if (!course_id) return respondError(res, '缺少课程ID');
    db.get(
        `SELECT course_status FROM feesystem WHERE record_type='course' AND course_id=?`,
        [course_id],
        (err, row) => {
            if (err) return respondError(res, '查询失败');
            if (!row) return respondError(res, '课程不存在');
            if (row.course_status === 'ended') return respondError(res, '已结课不可再开');
            db.run(
                `UPDATE feesystem SET course_status='open', updated_at=? WHERE record_type='course' AND course_id=?`,
                [nowISO(), course_id],
                function (err2) {
                    if (err2) return respondError(res, '更新失败');
                    res.json({ success: true });
                }
            );
        }
    );
});

// 结课
app.post('/api/fee/course/finish', (req, res) => {
    const { course_id } = req.body;
    if (!course_id) return respondError(res, '缺少课程ID');
    db.run(
        `UPDATE feesystem SET course_status='ended', updated_at=? WHERE record_type='course' AND course_id=?`,
        [nowISO(), course_id],
        function (err) {
            if (err) return respondError(res, '结课失败');
            if (this.changes === 0) return respondError(res, '课程不存在');
            // 追加一个 finish 记录
            db.run(
                `INSERT INTO feesystem (record_type, course_id, course_status, created_at, updated_at)
                 VALUES ('course_finish', ?, 'ended', ?, ?)`,
                [course_id, nowISO(), nowISO()],
                () => {}
            );
            res.json({ success: true });
        }
    );
});

// 课程列表 (可选 status, teacher)
app.get('/api/fee/courses', (req, res) => {
    const { status, teacher } = req.query;
    const params = [];
    let where = `WHERE record_type='course'`;
    if (status) { where += ' AND course_status=?'; params.push(status); }
    if (teacher) { where += ' AND teacher_username=?'; params.push(teacher); }
    db.all(
        `SELECT course_id, course_name, total_lessons, teacher_username, course_status, lesson_price
         FROM feesystem
         ${where}
         ORDER BY course_id ASC`,
        params,
        (err, rows) => {
            if (err) return respondError(res, '查询失败');
            res.json(rows || []);
        }
    );
});

// ========== 课程与学员关联（报名 / 剩余课时与费用） ==========
// 修改报名接口，支持 fee_attrs 数组
app.post('/api/fee/enroll', (req, res) => {
    const { course_id, username, remaining_lessons, lesson_price, fee_attrs } = req.body;
    if (!course_id || !username || typeof remaining_lessons !== 'number' || !Array.isArray(fee_attrs) || fee_attrs.length === 0)
        return respondError(res, '参数不完整');
    
    // 验证第一组费用属性和单价必填
    const firstAttr = fee_attrs[0];
    if (!firstAttr || !firstAttr.attribute || !firstAttr.price) {
        return respondError(res, '第一组费用属性和单价必填');
    }
    
    // 只保留前3组，并为每组添加初始剩余课次
    const attrs = fee_attrs.slice(0, 3).map(attr => ({
        attribute: attr.attribute,
        price: Number(attr.price),
        remaining_lessons: remaining_lessons // 每组都分配相同的初始课次
    }));
    
    const ts = nowISO();
    
    // 先删后插（幂等）
    db.run(
        `DELETE FROM feesystem WHERE record_type='enroll' AND course_id=? AND username=?`,
        [course_id, username],
        (deleteErr) => {
            if (deleteErr) {
                console.error('删除旧报名记录失败:', deleteErr);
                return respondError(res, '删除旧报名失败');
            }
            
            db.run(
                `INSERT INTO feesystem (
                    record_type, course_id, username, remaining_lessons, lesson_price, fee_attrs, created_at, updated_at
                ) VALUES ('enroll', ?, ?, ?, ?, ?, ?, ?)`,
                [course_id, username, remaining_lessons, lesson_price, JSON.stringify(attrs), ts, ts],
                function (err2) {
                    if (err2) {
                        console.error('报名插入失败:', err2);
                        return respondError(res, '报名插入失败: ' + err2.message);
                    }
                    res.json({ success: true, id: this.lastID });
                }
            );
        }
    );
});

// 更新报名数据
app.post('/api/fee/enroll/update', (req, res) => {
    const { course_id, username, remaining_lessons, remaining_fee, lesson_price } = req.body;
    if (!course_id || !username) return respondError(res, '缺少参数');
    const sets = [];
    const params = [];
    if (remaining_lessons !== undefined) { sets.push('remaining_lessons=?'); params.push(remaining_lessons); }
    if (remaining_fee !== undefined) { sets.push('remaining_fee=?'); params.push(remaining_fee); }
    if (lesson_price !== undefined) { sets.push('lesson_price=?'); params.push(lesson_price); }
    if (sets.length === 0) return respondError(res, '无可更新字段');
    sets.push('updated_at=?'); params.push(nowISO());
    params.push(course_id, username);
    db.run(
        `UPDATE feesystem SET ${sets.join(',')} WHERE record_type='enroll' AND course_id=? AND username=?`,
        params,
        function (err) {
            if (err) return respondError(res, '更新失败');
            if (this.changes === 0) return respondError(res, '报名不存在');
            res.json({ success: true });
        }
    );
});

// 删除报名
app.post('/api/fee/enroll/delete', (req, res) => {
    const { course_id, username } = req.body;
    if (!course_id || !username) return respondError(res, '缺少参数');
    db.run(
        `DELETE FROM feesystem WHERE record_type='enroll' AND course_id=? AND username=?`,
        [course_id, username],
        function (err) {
            if (err) return respondError(res, '删除失败');
            res.json({ success: true, deleted: this.changes });
        }
    );
});

// 查询报名接口返回 fee_attrs 字段
app.get('/api/fee/enrollments', (req, res) => {
    let sql = `SELECT * FROM feesystem WHERE record_type = 'enroll'`;
    const params = [];
    if (req.query.course_id) {
        sql += ' AND course_id = ?';
        params.push(req.query.course_id);
    }
    if (req.query.username) {
        sql += ' AND username = ?';
        params.push(req.query.username);
    }
    db.all(sql, params, (err, rows) => {
        if (err) return respondError(res, '查询失败');
        // 确保 fee_attrs 是数组
        const results = rows.map(row => {
            if (row.fee_attrs && typeof row.fee_attrs === 'string') {
                try {
                    row.fee_attrs = JSON.parse(row.fee_attrs);
                } catch (e) {
                    row.fee_attrs = []; // 解析失败则置为空数组
                }
            } else if (!row.fee_attrs) {
                row.fee_attrs = [];
            }
            return row;
        });
        res.json(results);
    });
});

// ===== 消课 / 加课 ==========

// 修复：消课接口优先使用 fee_attrs 顺序
app.post('/api/fee/lesson/consume', (req, res) => {
    const { course_id, username } = req.body;
    if (!course_id || !username) return respondError(res, '缺少参数');
    
    db.get(
        `SELECT id, fee_attrs, remaining_lessons FROM feesystem 
         WHERE record_type='enroll' AND course_id=? AND username=?`,
        [course_id, username],
        (err, row) => {
            if (err) return respondError(res, err.message);
            if (!row) return respondError(res, '未找到报名记录');

            let fee_attrs = [];
            try {
                fee_attrs = row.fee_attrs ? JSON.parse(row.fee_attrs) : [];
            } catch (e) {
                fee_attrs = [];
            }

            let usedAttribute = '普通';
            let success = false;

            // 1. 课程余次扣减（无条件）
            let newRemainingLessons = Math.max(0, Number(row.remaining_lessons || 0) - 1);

            // 2. 属性课次扣减（有条件）
            if (fee_attrs.length > 0) {
                // 找到第一个还有剩余课次的属性
                let targetIdx = fee_attrs.findIndex(fa => Number(fa.remaining_lessons || 0) > 0);
                
                if (targetIdx >= 0) {
                    const targetAttr = fee_attrs[targetIdx];
                    usedAttribute = targetAttr.attribute;
                    
                    // 扣减该属性的课次
                    fee_attrs[targetIdx].remaining_lessons = Math.max(0, Number(targetAttr.remaining_lessons || 0) - 1);
                    success = true;
                } else {
                    // 所有属性课次都用完了，不扣费但课程余次仍然扣减
                    success = false;
                }
            }

            // 更新数据库
            db.run(
                `UPDATE feesystem SET remaining_lessons=?, fee_attrs=?, updated_at=? 
                 WHERE record_type='enroll' AND course_id=? AND username=?`,
                [newRemainingLessons, JSON.stringify(fee_attrs), nowISO(), course_id, username],
                function (updateErr) {
                    if (updateErr) return respondError(res, updateErr.message);
                    res.json({ 
                        success: true, 
                        used_attribute: usedAttribute,
                        fee_deducted: success,
                        message: success ? `消课成功，使用属性：${usedAttribute}` : '课程余次已扣减，但所有属性课次已用完，未扣费'
                    });
                }
            );
        }
    );
});

// 修复：加课接口优先为 fee_attrs 中当前可用属性加回一次课次
app.post('/api/fee/lesson/addback', (req, res) => {
    const { course_id, username } = req.body;
    if (!course_id || !username) {
        return res.status(400).json({ success: false, error: '缺少参数' });
    }

    db.get(
        `SELECT id, fee_attrs, remaining_lessons FROM feesystem 
         WHERE record_type='enroll' AND course_id=? AND username=?`,
        [course_id, username],
        (err, row) => {
            if (err) {
                console.error('[addback] DB error:', err.message);
                return res.status(500).json({ success: false, error: err.message });
            }
            if (!row) return res.status(404).json({ success: false, error: '报名记录不存在' });

            let fee_attrs = [];
            try {
                fee_attrs = row.fee_attrs ? JSON.parse(row.fee_attrs) : [];
                if (!Array.isArray(fee_attrs)) fee_attrs = [];
            } catch (e) {
                return res.status(500).json({ success: false, error: 'fee_attrs 解析失败' });
            }

            if (fee_attrs.length === 0) {
                return res.status(400).json({ success: false, error: '该报名未配置 fee_attrs，无法按属性加课' });
            }

            let idx = fee_attrs.findIndex(a => Number(a.remaining_lessons) > 0);
            if (idx === -1) idx = 0; // 全部耗尽时回到第一组
            fee_attrs[idx].remaining_lessons = Number(fee_attrs[idx].remaining_lessons || 0) + 1;
            const usedAttr = fee_attrs[idx].attribute;
            const newRemainingLessons = Number(row.remaining_lessons || 0) + 1;

            db.run(
                `UPDATE feesystem 
                 SET fee_attrs=?, remaining_lessons=?, updated_at=? 
                 WHERE id=?`,
                [JSON.stringify(fee_attrs), newRemainingLessons, new Date().toISOString(), row.id],
                function (uErr) {
                    if (uErr) {
                        console.error('[addback] update error:', uErr.message);
                        return res.status(500).json({ success: false, error: uErr.message });
                    }
                    console.log('[addback] OK', { course_id, username, targetAttr: usedAttr, after: fee_attrs.map(a => ({ a: a.attribute, r: a.remaining_lessons })) });
                    res.json({
                        success: true,
                        target_attribute: usedAttr,
                        fee_attrs,
                        remaining_lessons: newRemainingLessons
                    });
                }
            );
        }
    );
});

// 合并视图：课程+学员剩余
app.get('/api/fee/lesson/overview', (req, res) => {
    const { teacher, all } = req.query;
    const params = [];
    let whereCourse = `c.record_type='course' AND c.course_status='open'`;
    if (teacher) { whereCourse += ' AND c.teacher_username=?'; params.push(teacher); }
    db.all(
        `SELECT 
            c.course_id, c.course_name, c.total_lessons, c.teacher_username, c.course_status, c.lesson_price,
            e.username, e.remaining_lessons, e.remaining_fee
         FROM feesystem c
         LEFT JOIN feesystem e 
           ON e.record_type='enroll' AND e.course_id=c.course_id
         WHERE ${whereCourse}
         ORDER BY c.course_id, e.username`,
        params,
        (err, rows) => {
            if (err) return respondError(res, '查询失败');
            res.json(rows || []);
        }
    );
});

// 新增：结课时导出Excel数据接口
app.post('/api/fee/export-course-excel', async (req, res) => {
    const { course_ids } = req.body;
    if (!Array.isArray(course_ids) || course_ids.length === 0) {
        return res.status(400).json({ error: '缺少课程ID参数' });
    }
    
    try {
        // 1. 获取课程基本信息
        const courses = [];
        for (const course_id of course_ids) {
            const course = await new Promise((resolve, reject) => {
                db.get(
                    `SELECT * FROM feesystem WHERE record_type='course' AND course_id=?`,
                    [course_id],
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    }
                );
            });
            if (course) courses.push(course);
        }
        
        // 2. 获取报名信息（学员信息）
        const enrollments = [];
        for (const course_id of course_ids) {
            const enrolls = await new Promise((resolve, reject) => {
                db.all(
                    `SELECT * FROM feesystem WHERE record_type='enroll' AND course_id=?`,
                    [course_id],
                    (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows || []);
                    }
                );
            });
            enrollments.push(...enrolls);
        }
        
        // 3. 获取学员余额信息
        const usernames = [...new Set(enrollments.map(e => e.username))];
        const userBalances = {};
        for (const username of usernames) {
            const balances = await new Promise((resolve, reject) => {
                db.all(
                    `SELECT * FROM fee_balances WHERE username=?`,
                    [username],
                    (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows || []);
                    }
                );
            });
            userBalances[username] = balances;
        }
        
        // 4. 获取签到表信息
        const attendanceData = await new Promise((resolve, reject) => {
            const placeholders = course_ids.map(() => '?').join(',');
            db.all(
                `SELECT * FROM lesson_attendance WHERE course_id IN (${placeholders}) ORDER BY course_id, lesson_index, student`,
                course_ids,
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
        
        // 5. 组织数据结构
        const exportData = {
            timestamp: new Date().toISOString(),
            courses: courses.map(c => ({
                course_id: c.course_id,
                course_name: c.course_name,
                total_lessons: c.total_lessons,
                teacher_username: c.teacher_username,
                lesson_price: c.lesson_price,
                course_status: c.course_status
            })),
            enrollments: enrollments.map(e => {
                let fee_attrs = [];
                try {
                    fee_attrs = e.fee_attrs ? JSON.parse(e.fee_attrs) : [];
                } catch (err) {
                    fee_attrs = [];
                }
                return {
                    course_id: e.course_id,
                    username: e.username,
                    remaining_lessons: e.remaining_lessons,
                    remaining_fee: e.remaining_fee,
                    lesson_price: e.lesson_price,
                    fee_attrs: fee_attrs
                };
            }),
            userBalances: userBalances,
            attendance: attendanceData.map(a => ({
                course_id: a.course_id,
                lesson_index: a.lesson_index,
                date: a.date,
                student: a.student,
                status: a.status,
                makeup_date: a.makeup_date
            }))
        };
        
        res.json({ success: true, data: exportData });
        
    } catch (error) {
        console.error('导出课程数据失败:', error);
        res.status(500).json({ error: '导出失败: ' + error.message });
    }
});

// ===== 签到表系统开始 =====
// 1. 初始化签到表
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS lesson_attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id TEXT NOT NULL,
        lesson_index INTEGER NOT NULL,
        date TEXT,
        student TEXT NOT NULL,
        status INTEGER DEFAULT 0, -- 0=未上课, 1=上课, 2=补课
        makeup_date TEXT,
        created_at TEXT,
        updated_at TEXT,
        UNIQUE(course_id, lesson_index, student)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_lesson_attendance_course_lesson ON lesson_attendance(course_id, lesson_index)`);
});

// 2. 查询签到表（支持多课程，返回结构：{ course_id, lessons: [{lesson_index, date, students:[{student, status, makeup_date}]}] }）
app.get('/api/lesson-attendance', (req, res) => {
    let { course_ids } = req.query;
    if (!course_ids) return res.status(400).json({ error: '缺少课程ID' });
    if (typeof course_ids === 'string') course_ids = course_ids.split(',');
    // 查询所有相关签到数据
    db.all(
        `SELECT * FROM lesson_attendance WHERE course_id IN (${course_ids.map(() => '?').join(',')}) ORDER BY course_id, lesson_index, student`,
        course_ids,
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            // 组装结构
            const result = {};
            rows.forEach(r => {
                if (!result[r.course_id]) result[r.course_id] = {};
                if (!result[r.course_id][r.lesson_index]) result[r.course_id][r.lesson_index] = { date: r.date, students: [] };
                result[r.course_id][r.lesson_index].students.push({
                    student: r.student,
                    status: r.status,
                    makeup_date: r.makeup_date
                });
            });
            // 转为数组结构
            const arr = Object.entries(result).map(([cid, lessonsObj]) => ({
                course_id: cid,
                lessons: Object.entries(lessonsObj).map(([idx, v]) => ({
                    lesson_index: Number(idx),
                    date: v.date,
                    students: v.students
                }))
            }));
            res.json(arr);
        }
    );
});

// 3. 保存签到表（批量写入/更新，前端点击“保存”时调用）
app.post('/api/lesson-attendance/save', (req, res) => {
    const { course_id, lessons } = req.body;
    if (!course_id || !Array.isArray(lessons)) return res.status(400).json({ error: '参数不完整' });
    let pending = 0, fail = 0;
    lessons.forEach(lesson => {
        const { lesson_index, date, students } = lesson;
        if (!lesson_index || !Array.isArray(students)) return;
        students.forEach(s => {
            pending++;
            db.run(
                `INSERT INTO lesson_attendance (course_id, lesson_index, date, student, status, makeup_date, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(course_id, lesson_index, student)
                 DO UPDATE SET date=excluded.date, status=excluded.status, makeup_date=excluded.makeup_date, updated_at=excluded.updated_at`,
                [course_id, lesson_index, date || null, s.student, s.status, s.makeup_date || null, new Date().toISOString(), new Date().toISOString()],
                err => { if (err) fail++; if (--pending === 0) res.json({ success: fail === 0, fail }); }
            );
        });
    });
    if (pending === 0) res.json({ success: true });
});

// 4. 单格修改（签到/补课/清空/日期修改）
app.post('/api/lesson-attendance/update', (req, res) => {
    const { course_id, lesson_index, student, status, makeup_date, date } = req.body;
    if (!course_id || !lesson_index || !student) return res.status(400).json({ error: '参数不完整' });
    // status: 0=未上课, 1=上课, 2=补课, null=清空
    if (status === null || status === undefined) {
        // 清空该格
        db.run(
            `DELETE FROM lesson_attendance WHERE course_id=? AND lesson_index=? AND student=?`,
            [course_id, lesson_index, student],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            }
        );
    } else {
        // 更新/插入
        db.run(
            `INSERT INTO lesson_attendance (course_id, lesson_index, date, student, status, makeup_date, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(course_id, lesson_index, student)
             DO UPDATE SET date=excluded.date, status=excluded.status, makeup_date=excluded.makeup_date, updated_at=excluded.updated_at`,
            [course_id, lesson_index, date || null, student, status, makeup_date || null, new Date().toISOString(), new Date().toISOString()],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            }
        );
    }
});

// 5. 日期格修改（单独修改课次日期，前端弹窗选择后调用）
app.post('/api/lesson-attendance/update-date', (req, res) => {
    const { course_id, lesson_index, date } = req.body;
    if (!course_id || !lesson_index) return res.status(400).json({ error: '参数不完整' });
    // 更新所有该课次的date字段
    db.run(
        `UPDATE lesson_attendance SET date=? WHERE course_id=? AND lesson_index=?`,
        [date || null, course_id, lesson_index],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// 6. 查询课程课次已签到的日期列表（用于渲染第二行日期）
app.get('/api/lesson-attendance/dates', (req, res) => {
    const { course_id } = req.query;
    if (!course_id) return res.status(400).json({ error: '缺少课程ID' });
    db.all(
        `SELECT lesson_index, date FROM lesson_attendance WHERE course_id=? GROUP BY lesson_index ORDER BY lesson_index`,
        [course_id],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// 7. 按课程ID删除签到表数据接口
app.post('/api/lesson-attendance/delete-by-course', (req, res) => {
    const { course_id } = req.body;
    if (!course_id) {
        return res.status(400).json({ success: false, error: '缺少课程ID参数' });
    }
    
    db.run(
        `DELETE FROM lesson_attendance WHERE course_id = ?`,
        [course_id],
        function(err) {
            if (err) {
                console.error('删除签到表数据失败:', err);
                return res.status(500).json({ success: false, error: err.message });
            }
            res.json({ 
                success: true, 
                deleted: this.changes,
                message: `已删除课程 ${course_id} 的 ${this.changes} 条签到记录`
            });
        }
    );
});
// ===== 签到表系统结束 =====

// 简单 CSV 导出（Excel 友好，UTF-8 BOM）
app.get('/api/fee/export-students-csv', (req, res) => {
    const ATTRS = [
        { key: '普通', cols: ['普通余额','普通总课次','普通剩余课次'] },
        { key: '小学课包', cols: ['小学课包余额','小学课包总课次','小学课包剩余课次'] },
        { key: '初中课包', cols: ['初中课包余额','初中课包总课次','初中课包剩余课次'] },
        { key: '小学两期优惠', cols: ['小学两期优惠余额','小学两期优惠总课次','小学两期优惠剩余课次'] },
        { key: '初中两期优惠', cols: ['初中两期优惠余额','初中两期优惠总课次','初中两期优惠剩余课次'] },
        { key: '艺术50', cols: ['艺术50余额','艺术50总课次','艺术50剩余课次'] },
        { key: '艺术75', cols: ['艺术75余额','艺术75总课次','艺术75剩余课次'] }
    ];
    const headers = ['学生ID','学生姓名'].concat(ATTRS.flatMap(a=>a.cols));
    db.all(`SELECT user_id, username, is_admin, is_teacher FROM feesystem WHERE record_type='user' ORDER BY user_id ASC`, [], (err, users) => {
        if (err) return res.status(500).json({ error: err.message });
        const students = (users||[]).filter(u => !(Number(u.is_admin)===1) && !(Number(u.is_teacher)===1));
        db.all(`SELECT username, fee_attribute, balance, fee_attr_total_lessons, fee_attr_remaining_lessons FROM fee_balances`, [], (err2, balances) => {
            if (err2) return res.status(500).json({ error: err2.message });
            const balMap = {};
            (balances||[]).forEach(b=>{
                if (!b.username) return;
                balMap[b.username] = balMap[b.username] || {};
                balMap[b.username][b.fee_attribute || '普通'] = {
                    balance: b.balance,
                    total: b.fee_attr_total_lessons,
                    remain: b.fee_attr_remaining_lessons
                };
            });
            // 构造 CSV 行
            const escapeCsv = v => {
                if (v === null || v === undefined) return '';
                const s = String(v);
                if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) return `"${s.replace(/"/g,'""')}"`;
                return s;
            };
            const rows = [headers.map(escapeCsv).join(',')];
            students.forEach(s=>{
                const uname = s.username || '';
                const uid = s.user_id || '';
                const row = [uid, uname];
                ATTRS.forEach(attr=>{
                    const v = (balMap[uname] && balMap[uname][attr.key]) || null;
                    if (!v) {
                        row.push('', '', '');
                    } else {
                        // 空表示无该项，0 或数字表示存在
                        row.push(v.balance === null || v.balance === undefined ? '' : v.balance);
                        row.push(v.total === null || v.total === undefined ? '' : v.total);
                        row.push(v.remain === null || v.remain === undefined ? '' : v.remain);
                    }
                });
                rows.push(row.map(escapeCsv).join(','));
            });
            const bom = '\uFEFF';
            const csv = bom + rows.join('\r\n');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename=students.csv');
            res.send(csv);
        });
    });
});

// 简单 CSV 解析器（支持双引号转义）
function parseCsv(text) {
    const rows = [];
    let i = 0, len = text.length;
    let cur = '', inQuote = false;
    const pushCell = () => { currentRow.push(cur); cur=''; };
    let currentRow = [];
    while (i < len) {
        const ch = text[i];
        if (inQuote) {
            if (ch === '"') {
                if (i+1 < len && text[i+1] === '"') { cur += '"'; i += 2; continue; }
                inQuote = false; i++; continue;
            } else {
                cur += ch; i++; continue;
            }
        } else {
            if (ch === '"') { inQuote = true; i++; continue; }
            if (ch === ',') { pushCell(); i++; continue; }
            if (ch === '\r') { pushCell(); rows.push(currentRow); currentRow = []; i++; if (i < len && text[i] === '\n') i++; continue; }
            if (ch === '\n') { pushCell(); rows.push(currentRow); currentRow = []; i++; continue; }
            cur += ch; i++;
        }
    }
    // end
    if (inQuote) { /* 忽略不闭合引号 */ }
    if (cur !== '' || currentRow.length>0) { pushCell(); rows.push(currentRow); }
    return rows;
}

// 较保守的导入：接收 CSV 文件，按列规则覆盖/新增 fee_balances，并创建缺失用户（user_id 由后端生成）
// 字段要求：header 中至少有 学生姓名，学生ID 可选；其余列按导出时的列名对应
app.post('/api/fee/import-students-csv', multerMemory.single('file'), async (req, res) => {
    try {
        if (!req.file || !req.file.buffer) return res.status(400).json({ success:false, error:'未上传文件' });
        const txt = req.file.buffer.toString('utf8').replace(/\uFEFF/g,'').trim();
        if (!txt) return res.status(400).json({ success:false, error:'文件为空' });
        const data = parseCsv(txt);
        if (!Array.isArray(data) || data.length < 2) return res.status(400).json({ success:false, error:'表格至少包含表头和一行数据' });
        const header = (data[0]||[]).map(h => h ? String(h).trim() : '');
        const colIndex = {}; header.forEach((h,i)=>colIndex[h]=i);
        if (colIndex['学生姓名'] === undefined) return res.status(400).json({ success:false, error:'缺少 学生姓名 列' });

        const ATTRS = [
            { key: '普通', cols: ['普通余额','普通总课次','普通剩余课次'] },
            { key: '小学课包', cols: ['小学课包余额','小学课包总课次','小学课包剩余课次'] },
            { key: '初中课包', cols: ['初中课包余额','初中课包总课次','初中课包剩余课次'] },
            { key: '小学两期优惠', cols: ['小学两期优惠余额','小学两期优惠总课次','小学两期优惠剩余课次'] },
            { key: '初中两期优惠', cols: ['初中两期优惠余额','初中两期优惠总课次','初中两期优惠剩余课次'] },
            { key: '艺术50', cols: ['艺术50余额','艺术50总课次','艺术50剩余课次'] },
            { key: '艺术75', cols: ['艺术75余额','艺术75总课次','艺术75剩余课次'] }
        ];

        const dbGet = (sql, params=[]) => new Promise((r,j)=> db.get(sql, params, (e,row)=> e?j(e):r(row)));
        const dbRun = (sql, params=[]) => new Promise((r,j)=> db.run(sql, params, function(e){ e?j(e):r(this); }));
        const dbAll = (sql, params=[]) => new Promise((r,j)=> db.all(sql, params, (e,rows)=> e?j(e):r(rows)));

        // 如果代码中已有生成 userId 的函数 generateUserId(callback)，封装 Promise 版本；否则返回空字符串
        const genUserId = () => new Promise(resolve=>{
            if (typeof generateUserId === 'function') {
                try { generateUserId((err, id) => resolve(err ? '' : (id||''))); } catch(e){ resolve(''); }
            } else resolve('');
        });

        let processed = 0, createdUsers = 0, updatedBalances = 0;
        for (let ri = 1; ri < data.length; ri++) {
            const row = data[ri];
            if (!row || row.length === 0) continue;
            const username = (row[colIndex['学生姓名']]||'').toString().trim();
            if (!username) continue;
            const studentId = colIndex['学生ID'] !== undefined ? (row[colIndex['学生ID']]||'').toString().trim() : '';

            // 确保用户存在
            let userRow = await dbGet(`SELECT * FROM feesystem WHERE record_type='user' AND username=?`, [username]);
            if (!userRow) {
                // 若提供 studentId 且未占用则使用，否则让后端生成
                let finalUserId = studentId || '';
                if (finalUserId) {
                    const dup = await dbGet(`SELECT 1 FROM feesystem WHERE record_type='user' AND user_id=?`, [finalUserId]);
                    if (dup) finalUserId = '';
                }
                if (!finalUserId) finalUserId = await genUserId();
                await dbRun(`INSERT INTO feesystem (record_type, user_id, username, password, is_admin, is_teacher, balance, created_at, updated_at) VALUES ('user', ?, ?, ?, 0, 0, 0, ?, ?)`,
                    [finalUserId || '', username, '000000', new Date().toISOString(), new Date().toISOString()]);
                createdUsers++;
            } else {
                if (userRow.is_admin || userRow.is_teacher) {
                    await dbRun(`UPDATE feesystem SET is_admin=0, is_teacher=0 WHERE record_type='user' AND username=?`, [username]);
                }
            }

            // 处理每个费用属性列组
            for (const attr of ATTRS) {
                const ciBal = colIndex[attr.cols[0]];
                const ciTot = colIndex[attr.cols[1]];
                const ciRem = colIndex[attr.cols[2]];
                if (ciBal === undefined && ciTot === undefined && ciRem === undefined) continue;
                const rawBal = ciBal!==undefined ? row[ciBal] : null;
                const rawTot = ciTot!==undefined ? row[ciTot] : null;
                const rawRem = ciRem!==undefined ? row[ciRem] : null;
                const allEmpty = [rawBal, rawTot, rawRem].every(v => v === null || v === undefined || String(v).trim() === '');
                if (allEmpty) continue; // 不修改该属性
                const parseCell = v => {
                    if (v === null || v === undefined) return null;
                    const s = String(v).trim();
                    if (s === '') return null;
                    const n = Number(s);
                    return isNaN(n) ? null : n;
                };
                const balNum = parseCell(rawBal);
                const totNum = parseCell(rawTot);
                const remNum = parseCell(rawRem);
                // 如果全部解析为 null，跳过
                if (balNum === null && totNum === null && remNum === null) continue;
                // upsert fee_balances by username + fee_attribute
                const existing = await dbGet(`SELECT id FROM fee_balances WHERE username=? AND fee_attribute=?`, [username, attr.key]);
                if (existing) {
                    const parts = [], params = [];
                    if (balNum !== null) { parts.push('balance=?'); params.push(balNum); }
                    if (totNum !== null) { parts.push('fee_attr_total_lessons=?'); params.push(totNum); }
                    if (remNum !== null) { parts.push('fee_attr_remaining_lessons=?'); params.push(remNum); }
                    if (parts.length>0) {
                        params.push(new Date().toISOString(), existing.id);
                        await dbRun(`UPDATE fee_balances SET ${parts.join(',')}, updated_at=? WHERE id=?`, params);
                        updatedBalances++;
                    }
                } else {
                    // 插入：如果 balance 为 null 则插 0? 这里保持规则：空 => 不创建，只有部分列有值才创建；但 we are already in not-all-empty branch
                    await dbRun(`INSERT INTO fee_balances (username, fee_attribute, balance, fee_attr_total_lessons, fee_attr_remaining_lessons, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
                        [username, attr.key, balNum === null ? 0 : balNum, totNum === null ? null : totNum, remNum === null ? null : remNum, new Date().toISOString()]);
                    updatedBalances++;
                }
            }
            processed++;
        }

        // 同步每个用户的 feesystem.balance 为 fee_balances 的 sum（可选但推荐）
        const allUsers = await dbAll(`SELECT username FROM feesystem WHERE record_type='user'`);
        for (const u of (allUsers||[])) {
            const srow = await dbGet(`SELECT SUM(balance) as total FROM fee_balances WHERE username=?`, [u.username]);
            const totalVal = srow && srow.total ? Number(srow.total) : 0;
            await dbRun(`UPDATE feesystem SET balance=? WHERE record_type='user' AND username=?`, [Math.round(totalVal*100)/100, u.username]);
        }

        res.json({ success:true, processed, createdUsers, updatedBalances });
    } catch (e) {
        console.error('import-students-csv error:', e);
        res.status(500).json({ success:false, error: e.message });
    }
});
// ===== 线下学员交费与课消系统结束 =====

// =====课堂语音识别开始=====
// 简单内存临时存储：{ sessionId -> [ { text, ts } ] }
const tempRecognitionStore = new Map();

// POST /api/recognize/temp  -> body: { sessionId, text }
// 将识别片段追加到 session 的内存队列中
app.post('/api/recognize/temp', (req, res) => {
    const { sessionId, text } = req.body || {};
    if (!sessionId || typeof text !== 'string') return res.status(400).json({ error: 'sessionId 和 text 必需' });

    // 后端净化：去掉转义的 "\n"、实际换行与回车，压缩多空白为单个空格，并 trim
    const cleaned = String(text || '')
        .replace(/\\n/g, ' ')    // 反斜杠 + n（被转义保存的情况）
        .replace(/\r?\n/g, ' ')  // 实际换行或回车
        .replace(/\s+/g, ' ')
        .trim();

    // 不保存空内容，避免占位
    if (!cleaned) return res.json({ success: true });

    const list = tempRecognitionStore.get(sessionId) || [];
    list.push({ text: cleaned, ts: Date.now() });
    tempRecognitionStore.set(sessionId, list);
    res.json({ success: true });
});

// GET /api/recognize/temp?sessionId=...
// 返回该 session 的全部临时识别结果数组（按追加顺序），对历史数据再做一次净化以兼容旧数据
app.get('/api/recognize/temp', (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId 必需' });

    const list = tempRecognitionStore.get(sessionId) || [];
    const texts = list.map(it => String(it.text || '')
        .replace(/\\n/g, ' ')
        .replace(/\r?\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    ).filter(Boolean);

    res.json({ texts });
});

// DELETE /api/recognize/temp?sessionId=...
// 清空该 session 的临时结果
app.delete('/api/recognize/temp', (req, res) => {
    const sessionId = req.query.sessionId || (req.body && req.body.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'sessionId 必需' });
    tempRecognitionStore.delete(sessionId);
    res.json({ success: true });
});

// 新增：每天0点清空所有房间的暂存内容
function scheduleTempRecognitionClear() {
    function getNextMidnight() {
        const now = new Date();
        const next = new Date(now);
        next.setHours(24, 0, 0, 0);
        return next.getTime();
    }
    const now = Date.now();
    const nextMidnight = getNextMidnight();
    const msUntilNextMidnight = nextMidnight - now;
    setTimeout(() => {
        tempRecognitionStore.clear();
        // 之后每天清理一次
        setInterval(() => tempRecognitionStore.clear(), 24 * 60 * 60 * 1000);
    }, msUntilNextMidnight);
}
scheduleTempRecognitionClear();
// =====课堂语音识别结束=====

// ====== 新童行单词记忆系统开始 ======
// ====== 新童行单词记忆_英文单词管理（engword 表）开始 ======
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS engword (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seq TEXT UNIQUE,
        word TEXT UNIQUE COLLATE NOCASE,
        pos TEXT,
        meaning TEXT,
        details TEXT,
        libraries TEXT,
        created_at TEXT,
        updated_at TEXT
    )`);
});

// 生成下一个序号 TXW00001
function generateEngwordSeq() {
    return new Promise((resolve, reject) => {
        // 收集数据库中已有的 seq 数字部分，找到最小可用正整数以实现回收
        db.all(`SELECT seq FROM engword WHERE seq IS NOT NULL AND seq <> ''`, [], (err, rows) => {
            if (err) return reject(err);
            const used = new Set();
            (rows || []).forEach(r => {
                const s = String(r.seq || '');
                const m = s.match(/(\d+)$/);
                if (m) {
                    const n = parseInt(m[1], 10);
                    if (!isNaN(n) && n >= 1) used.add(n);
                }
            });
            // 找到最小未被使用的正整数
            let i = 1;
            while (used.has(i)) i++;
            const seq = 'TXW' + String(i).padStart(5, '0');
            resolve(seq);
        });
    });
}

// 列出所有单词
app.get('/api/engwords', (req, res) => {
    db.all(`SELECT seq, word, pos, meaning, details, libraries, created_at, updated_at FROM engword ORDER BY LOWER(word) ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const out = (rows || []).map(r => ({
            seq: r.seq,
            word: r.word,
            pos: r.pos,
            meaning: r.meaning,
            details: r.details,
            libraries: r.libraries ? r.libraries.split(',').map(s => s.trim()).filter(Boolean) : [],
            created_at: r.created_at,
            updated_at: r.updated_at
        }));
        res.json(out);
    });
});

// 新增或更新单词（根据 word 不区分大小写）
app.post('/api/engword/upsert', express.json(), (req, res) => {
    const { word, pos = '', meaning = '', details = '', libraries = [] } = req.body || {};
    if (!word || !String(word).trim()) return res.status(400).json({ error: '缺少 word 字段' });
    const libs = Array.isArray(libraries) ? libraries.map(s => String(s).trim()).filter(Boolean) : String(libraries || '').split(',').map(s => s.trim()).filter(Boolean);
    const libsStr = libs.join(',');
    const now = new Date().toISOString();
    const lw = String(word).trim();
    db.get(`SELECT * FROM engword WHERE LOWER(word)=LOWER(?)`, [lw], async (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) {
            db.run(`UPDATE engword SET pos=?, meaning=?, details=?, libraries=?, updated_at=? WHERE id=?`,
                [pos, meaning, details, libsStr, now, row.id],
                function(uerr) {
                    if (uerr) return res.status(500).json({ error: uerr.message });
                    res.json({ success: true, action: 'updated', seq: row.seq });
                });
        } else {
            try {
                const seq = await generateEngwordSeq();
                db.run(`INSERT INTO engword (seq, word, pos, meaning, details, libraries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [seq, lw, pos, meaning, details, libsStr, now, now],
                    function(ierr) {
                        if (ierr) return res.status(500).json({ error: ierr.message });
                        res.json({ success: true, action: 'created', seq });
                    });
            } catch (e) {
                res.status(500).json({ error: e.message || '生成序号失败' });
            }
        }
    });
});

// 删除单词（支持 seq 或 word）
app.post('/api/engword/delete', express.json(), (req, res) => {
    const { seq, word, id } = req.body || {};
    if (!seq && !word && !id) return res.status(400).json({ error: '需要 seq 或 word 或 id' });
    let sql = 'DELETE FROM engword WHERE ';
    const params = [];
    if (id) { sql += 'id=?'; params.push(id); }
    else if (seq) { sql += 'seq=?'; params.push(seq); }
    else { sql += 'LOWER(word)=LOWER(?)'; params.push(String(word)); }
    db.run(sql, params, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, deleted: this.changes });
    });
});
// 删除所有单词
app.post('/api/engword/delete-all', (req, res) => {
    db.run('DELETE FROM engword', function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, deleted: this.changes });
    });
});

// 导出 CSV（含 BOM）
app.get('/api/engword/export-csv', (req, res) => {
    db.all(`SELECT seq, word, pos, meaning, details, libraries FROM engword ORDER BY LOWER(word) ASC`, [], (err, rows) => {
        if (err) return res.status(500).send('数据库错误');
        const header = ['Seq','Word','POS','Meaning','Details','Libraries'];
        const escape = v => {
            if (v === null || v === undefined) return '';
            const s = String(v);
            if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) return `"${s.replace(/"/g,'""')}"`;
            return s;
        };
        const lines = [header.join(',')];
        rows.forEach(r => {
            lines.push([
                escape(r.seq), escape(r.word), escape(r.pos), escape(r.meaning), escape(r.details), escape(r.libraries || '')
            ].join(','));
        });
        res.setHeader('Content-Type', 'text/csv; charset=UTF-8');
        res.setHeader('Content-Disposition', 'attachment; filename=engwords.csv');
        res.send('\uFEFF' + lines.join('\r\n'));
    });
});

// 简单 CSV 解析（支持双引号）
function parseCsvText(text) {
    const rows = [];
    let cur = '', row = [], inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i+1];
        if (ch === '"' ) {
            if (inQuotes && next === '"') { cur += '"'; i++; continue; }
            inQuotes = !inQuotes;
            continue;
        }
        if (!inQuotes && (ch === '\n' || (ch === '\r' && next === '\n'))) {
            if (ch === '\r' && next === '\n') i++;
            row.push(cur);
            rows.push(row);
            row = [];
            cur = '';
            continue;
        }
        if (!inQuotes && ch === ',') {
            row.push(cur);
            cur = '';
            continue;
        }
        cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
}

// 导入 CSV（覆盖已存在单词）
app.post('/api/engword/import-csv', multerMemory.single('file'), async (req, res) => {
    try {
        if (!req.file || !req.file.buffer) return res.status(400).json({ error: '未上传文件' });
        let text = req.file.buffer.toString('utf8').replace(/\uFEFF/g, '');
        const rows = parseCsvText(text);
        if (!Array.isArray(rows) || rows.length < 2) return res.status(400).json({ error: 'CSV 内容为空或格式不正确' });
        const header = (rows[0] || []).map(h => (h||'').toString().trim());
        const idx = {
            seq: header.findIndex(h => /seq/i.test(h)),
            word: header.findIndex(h => /word/i.test(h)),
            pos: header.findIndex(h => /pos/i.test(h)),
            meaning: header.findIndex(h => /meaning/i.test(h)),
            details: header.findIndex(h => /detail/i.test(h)),
            libraries: header.findIndex(h => /library|libraries/i.test(h))
        };
        if (idx.word === -1) return res.status(400).json({ error: 'CSV 必须包含 Word 列' });
        const dbGet = (sql, params=[]) => new Promise((r, j) => db.get(sql, params, (e, row) => e? j(e): r(row)));
        const dbRunP = (sql, params=[]) => new Promise((r, j) => db.run(sql, params, function(e){ e? j(e): r(this); }));

        let created = 0, updated = 0;
        for (let i = 1; i < rows.length; i++) {
            const r = rows[i];
            if (!r || r.length === 0) continue;
            const word = (r[idx.word] || '').toString().trim();
            if (!word) continue;
            const pos = idx.pos>=0 ? (r[idx.pos]||'').toString().trim() : '';
            const meaning = idx.meaning>=0 ? (r[idx.meaning]||'').toString().trim() : '';
            const details = idx.details>=0 ? (r[idx.details]||'').toString().trim() : '';
            let libraries = idx.libraries>=0 ? (r[idx.libraries]||'').toString().trim() : '';
            if (libraries && libraries.includes(';')) libraries = libraries.split(';').map(s=>s.trim()).filter(Boolean).join(',');
            libraries = libraries.split(',').map(s=>s.trim()).filter(Boolean).join(',');
            const now = new Date().toISOString();
            const exist = await dbGet(`SELECT * FROM engword WHERE LOWER(word)=LOWER(?)`, [word]);
            if (exist) {
                await dbRunP(`UPDATE engword SET pos=?, meaning=?, details=?, libraries=?, updated_at=? WHERE id=?`,
                    [pos, meaning, details, libraries, now, exist.id]);
                updated++;
            } else {
                const seq = await generateEngwordSeq();
                await dbRunP(`INSERT INTO engword (seq, word, pos, meaning, details, libraries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [seq, word, pos, meaning, details, libraries, now, now]);
                created++;
            }
        }
        res.json({ success: true, created, updated });
    } catch (e) {
        console.error('engword import error:', e);
        res.status(500).json({ error: e.message || '导入失败' });
    }
});
// ====== 新童行单词记忆_英文单词管理（engword 表）结束 ======
// ====== 新增：学生掌握单词表（engword_stuword）及轮次计数表 ======
db.serialize(() => {
    // 每个用户每个单词保存最近最多10个轮次记录（JSON数组）
    db.run(`CREATE TABLE IF NOT EXISTS engword_stuword (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        word TEXT NOT NULL COLLATE NOCASE,
        rounds TEXT DEFAULT '[]',   -- JSON array: [{round:1, at:"ISO string"}, ...]
        updated_at TEXT,
        UNIQUE(username, word)
    )`);

    // 简单的每用户轮次计数器，保证每次“提交作答（全对）”能分配下一个轮次号
    db.run(`CREATE TABLE IF NOT EXISTS engword_round_counter (
        username TEXT PRIMARY KEY,
        current INTEGER DEFAULT 0
    )`);
});

// ====== 新增API：为若干单词记录一次"全对轮次"（由 review.html 调用） ======
// POST /api/engword-stuword/mark-round
// body: { username: 'alice', words: ['friend','apple'] }
// 返回: { success:true, round: N, updated: 2 }
app.post('/api/engword-stuword/mark-round', (req, res) => {
    const { username, words } = req.body || {};
    if (!username || !Array.isArray(words) || words.length === 0) {
        return res.status(400).json({ success: false, error: '缺少 username 或 words' });
    }
    const now = new Date().toISOString();
    const lowerWords = words.map(w => String(w || '').trim()).filter(Boolean);
    if (lowerWords.length === 0) return res.status(400).json({ success: false, error: 'words 无效' });

    let processed = 0, failed = 0;
    const results = [];

    db.serialize(() => {
        const getStmt = db.prepare(`SELECT id, rounds FROM engword_stuword WHERE username = ? AND LOWER(word) = LOWER(?)`);
        const insertStmt = db.prepare(`INSERT INTO engword_stuword (username, word, rounds, updated_at) VALUES (?, ?, ?, ?)`);
        const updateStmt = db.prepare(`UPDATE engword_stuword SET rounds = ?, updated_at = ? WHERE id = ?`);

        lowerWords.forEach((word) => {
            getStmt.get([username, word], (gerr, row) => {
                try {
                    if (gerr) { failed++; results.push({ word, ok: false, error: gerr.message }); }
                    else {
                        let roundsArr = [];
                        if (row && row.rounds) {
                            try { roundsArr = JSON.parse(row.rounds) || []; } catch { roundsArr = []; }
                        }
                        // compute next round for this word independently
                        const maxR = roundsArr.length > 0 ? Math.max(...roundsArr.map(r => Number(r.round) || 0)) : 0;
                        const nextRound = (maxR || 0) + 1;
                        roundsArr.push({ round: nextRound, at: now });
                        // keep latest 10 entries
                        if (roundsArr.length > 10) roundsArr = roundsArr.slice(-10);
                        const roundsText = JSON.stringify(roundsArr);

                        if (row && row.id) {
                            updateStmt.run([roundsText, now, row.id], function(uerr) {
                                if (uerr) { failed++; results.push({ word, ok: false, error: uerr.message }); }
                                else { processed++; results.push({ word, ok: true, round: nextRound }); }
                            });
                        } else {
                            insertStmt.run([username, word, roundsText, now], function(ierr) {
                                if (ierr) { failed++; results.push({ word, ok: false, error: ierr.message }); }
                                else { processed++; results.push({ word, ok: true, round: nextRound }); }
                            });
                        }
                    }
                } catch (e) { failed++; results.push({ word, ok: false, error: e.message }); }
            });
        });

        // finalize and respond when all callbacks likely finished
        // use a short interval to wait for db callbacks to complete (sqlite3 callbacks are sync-ish in serialize but safer to wait)
        const checkDone = () => {
            if (processed + failed >= lowerWords.length) {
                getStmt.finalize();
                insertStmt.finalize();
                updateStmt.finalize();
                // compute a representative round number: if all words had same nextRound, return it; else null
                const roundsSet = new Set(results.filter(r=>r.ok).map(r=>r.round));
                const round = roundsSet.size === 1 ? [...roundsSet][0] : null;
                return res.json({ success: true, processed, failed, round, details: results });
            }
            setTimeout(checkDone, 60);
        };
        setTimeout(checkDone, 60);
    });
});

// ====== 新增API：查询某用户掌握单词及轮次 ======
// GET /api/engword-stuword/list?username=alice
// 返回: [{ word, rounds: [{round, at}, ...], updated_at }, ...]
app.get('/api/engword-stuword/list', (req, res) => {
    const username = req.query.username;
    if (!username) return res.status(400).json({ success: false, error: '缺少 username 参数' });

    db.all(`SELECT word, rounds, updated_at FROM engword_stuword WHERE username = ? ORDER BY LOWER(word) ASC`, [username], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        const out = (rows || []).map(r => {
            let arr = [];
            try { arr = JSON.parse(r.rounds || '[]'); } catch { arr = []; }
            return { word: r.word, rounds: arr, updated_at: r.updated_at };
        });
        res.json({ success: true, data: out });
    });
});

// 新增API：显式设置/覆盖若干单词的轮次（教师管理页面用）
// POST /api/engword-stuword/set-round
// body: { username: 'alice', words: ['word1','word2'], round: 3 }
// 返回: { success:true, updated: N }
app.post('/api/engword-stuword/set-round', (req, res) => {
    const { username, words, round } = req.body || {};
    if (!username || !Array.isArray(words) || words.length === 0) {
        return res.status(400).json({ success: false, error: '缺少 username 或 words' });
    }
    const r = parseInt(round, 10);
    if (isNaN(r) || r < 1) {
        return res.status(400).json({ success: false, error: 'round 必须为 >=1 的整数' });
    }

    const now = new Date().toISOString();
    // 规范化并去重单词
    const normalized = Array.from(new Set(words.map(w => String(w || '').trim()).filter(Boolean)));
    if (normalized.length === 0) return res.status(400).json({ success: false, error: '没有有效单词' });

    let updated = 0;
    let processed = 0;
    const roundsJson = JSON.stringify([{ round: r, at: now }]);

    db.serialize(() => {
        normalized.forEach(word => {
            db.get(
                `SELECT id FROM engword_stuword WHERE username = ? AND LOWER(word) = LOWER(?) LIMIT 1`,
                [username, word],
                (err, row) => {
                    if (err) {
                        processed++;
                        if (processed === normalized.length) res.json({ success: true, updated });
                        return;
                    }
                    if (row && row.id) {
                        db.run(
                            `UPDATE engword_stuword SET rounds = ?, updated_at = ? WHERE id = ?`,
                            [roundsJson, now, row.id],
                            function (upErr) {
                                if (!upErr) updated++;
                                processed++;
                                if (processed === normalized.length) res.json({ success: true, updated });
                            }
                        );
                    } else {
                        db.run(
                            `INSERT INTO engword_stuword (username, word, rounds, updated_at) VALUES (?, ?, ?, ?)`,
                            [username, word, roundsJson, now],
                            function (insErr) {
                                if (!insErr) updated++;
                                processed++;
                                if (processed === normalized.length) res.json({ success: true, updated });
                            }
                        );
                    }
                }
            );
        });
    });
});

// 新增API：删除指定用户的若干单词的轮次记录（教师管理页面用）
// DELETE /api/engword-stuword/delete-words
// body: { username: 'alice', words: ['word1','word2'] }
// 返回: { success:true, deleted: N }
app.delete('/api/engword-stuword/delete-words', express.json(), (req, res) => {
    const { username, words } = req.body || {};
    if (!username || !Array.isArray(words) || words.length === 0) {
        return res.status(400).json({ success: false, error: '缺少 username 或 words' });
    }

    // 规范化并去重单词
    const normalized = Array.from(new Set(words.map(w => String(w || '').trim()).filter(Boolean)));
    if (normalized.length === 0) return res.status(400).json({ success: false, error: '没有有效单词' });

    let deleted = 0;
    let processed = 0;

    db.serialize(() => {
        normalized.forEach(word => {
            db.run(
                `DELETE FROM engword_stuword WHERE username = ? AND LOWER(word) = LOWER(?)`,
                [username, word],
                function (err) {
                    if (!err && this.changes > 0) deleted += this.changes;
                    processed++;
                    if (processed === normalized.length) {
                        res.json({ success: true, deleted });
                    }
                }
            );
        });
    });
});

// ====== 新增API：查询所有词库类型及其总单词数量 ======
// GET /api/engword/library-counts
// 返回: { success:true, libraries: [{name:'中考', total:2000}, ...] }
app.get('/api/engword/library-counts', (req, res) => {
    db.all(`SELECT libraries FROM engword`, [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        const libCount = {};
        (rows || []).forEach(r => {
            const libs = (r.libraries || '').split(',').map(s => s.trim()).filter(Boolean);
            libs.forEach(lib => {
                libCount[lib] = (libCount[lib] || 0) + 1;
            });
        });
        const out = Object.entries(libCount).map(([name, total]) => ({ name, total }));
        res.json({ success: true, libraries: out });
    });
});

// 兼容：为 students / registered_stu 增加 selected_library 字段（记录用户已选择训练的词库）
// ===== 旧版单选词库接口已删除，改用 engword_selected 表的多选接口 =====

app.get('/api/vocabustu/merged-mastered', async (req, res) => {
    const username = req.query.username;
    if (!username) return res.status(400).json({ success: false, error: 'missing username' });

    try {
        // 1) 从 engword_stuword 取出该用户的掌握记录（解析 rounds 找到 max round >=7）
        db.all(`SELECT word, rounds FROM engword_stuword WHERE username = ?`, [username], async (err, rows) => {
            if (err) return res.status(500).json({ success: false, error: err.message });

            const engMastered = new Set();
            (rows || []).forEach(r => {
                try {
                    const rounds = JSON.parse(r.rounds || '[]');
                    const maxRound = rounds.reduce((m, it) => Math.max(m, Number(it.round) || 0), 0);
                    if (maxRound >= 7 && r.word) engMastered.add(String(r.word).trim());
                } catch (e) { /* ignore parse errors */ }
            });

            // 2) 调用现有 vocabustu 列表 API（或直接查询 vocabDb），兼容返回格式
            const base = `${req.protocol}://${req.get('host')}`;
            let vocabRows = [];
            try {
                const axios = require('axios');
                const r = await axios.get(`${base}/api/vocabustu/list?username=${encodeURIComponent(username)}`);
                vocabRows = Array.isArray(r.data) ? r.data : (r.data && r.data.success && Array.isArray(r.data.data) ? r.data.data : []);
            } catch (e) {
                // 若调用失败，继续以空列表处理
                vocabRows = [];
            }

            // 从 vocabRows 中摘出“已掌握单词”的字段（兼容不同返回格式）
            const vocabMastered = new Set();
            (vocabRows || []).forEach(r => {
                const w = r.word || r.word_text || r.vocab || r.wordName || '';
                if (w) vocabMastered.add(String(w).trim());
            });

            // 3) 去重：以“完全相同（包括空格）”为准（使用 trim 可去两端空白）
            const newFromEng = [];
            engMastered.forEach(w => {
                if (!vocabMastered.has(w)) newFromEng.push(w);
            });

            const result = {
                success: true,
                engMasteredCount: engMastered.size,
                vocabMasteredCount: vocabMastered.size,
                newFromEngCount: newFromEng.length,
                newFromEngWords: newFromEng,
                mergedCount: vocabMastered.size + newFromEng.length
            };
            res.json(result);
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ===== engword 选中词库（后端为准） =====
// 建表（放在数据库初始化区域，确保只创建一次）
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS engword_selected (
      username TEXT PRIMARY KEY,
      selected_list TEXT, -- JSON array of library names
      updated_at TEXT
    )
  `, (err) => {
    if (err) console.error('创建 engword_selected 表失败:', err.message);
  });
});

// GET: 查询某用户已选词库（返回 legacy 字段 `selected` 与新版 `selectedList`）
app.get('/api/engword/selected-library', (req, res) => {
  const username = (req.query.username || '').toString();
  if (!username) return res.json({ selected: '', selectedList: [] });

  db.get('SELECT selected_list FROM engword_selected WHERE username = ?', [username], (err, row) => {
    if (err) {
      console.error('/api/engword/selected-library error', err);
      return res.status(500).json({ error: err.message });
    }
    if (!row || !row.selected_list) return res.json({ selected: '', selectedList: [] });

    try {
      const list = JSON.parse(row.selected_list);
      if (Array.isArray(list)) {
        return res.json({ selected: list[0] || '', selectedList: list });
      } else {
        // fallback if stored as single string
        return res.json({ selected: String(row.selected_list), selectedList: [String(row.selected_list)] });
      }
    } catch (e) {
      // 非 JSON 格式，返回原始字符串作为单项
      return res.json({ selected: String(row.selected_list), selectedList: [String(row.selected_list)] });
    }
  });
});

// POST: 非破坏性地将某个词库标记为用户已选（不会删除/修改学生训练数据）
// 请求 body: { username: 'zhangsan', library: '中考' }
// 返回: { success: true, selectedList: [...] }
app.post('/api/engword/select-library-safe', express.json(), (req, res) => {
  const { username, library } = req.body || {};
  if (!username || !library) return res.status(400).json({ error: '缺少 username 或 library' });

  db.get('SELECT selected_list FROM engword_selected WHERE username = ?', [username], (err, row) => {
    if (err) {
      console.error('/api/engword/select-library-safe SELECT error', err);
      return res.status(500).json({ error: err.message });
    }

    let list = [];
    if (row && row.selected_list) {
      try {
        const parsed = JSON.parse(row.selected_list);
        if (Array.isArray(parsed)) list = parsed;
        else list = [String(parsed)];
      } catch (e) {
        list = [String(row.selected_list)];
      }
    }

    // 保持唯一性并把新选项追加到末尾（表示最近选择）
    if (!list.includes(library)) list.push(library);

    const serialized = JSON.stringify(list);
    const now = new Date().toISOString();

    // 使用 SQLite UPSERT（确保兼容较新 sqlite3）；若你的 sqlite 版本不支持，可改为先 UPDATE 再 INSERT
    const sql = `
      INSERT INTO engword_selected (username, selected_list, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        selected_list = excluded.selected_list,
        updated_at = excluded.updated_at
    `;
    db.run(sql, [username, serialized, now], function (upErr) {
      if (upErr) {
        console.error('/api/engword/select-library-safe UPSERT error', upErr);
        return res.status(500).json({ error: upErr.message });
      }
      return res.json({ success: true, selectedList: list, selected: list[0] || '' });
    });
  });
});

// POST: 取消某用户对某词库的选择（若移除后列表为空则删除记录）
// 请求 body: { username: 'zhangsan', library: '中考' }
// 返回: { success: true, selectedList: [...] }
app.post('/api/engword/unselect-library', express.json(), (req, res) => {
    const { username, library } = req.body || {};
    if (!username || !library) return res.status(400).json({ error: '缺少 username 或 library' });

    db.get('SELECT selected_list FROM engword_selected WHERE username = ?', [username], (err, row) => {
        if (err) {
            console.error('/api/engword/unselect-library SELECT error', err);
            return res.status(500).json({ error: err.message });
        }

        let list = [];
        if (row && row.selected_list) {
            try {
                const parsed = JSON.parse(row.selected_list);
                if (Array.isArray(parsed)) list = parsed.slice(); else list = [String(parsed)];
            } catch (e) {
                list = [String(row.selected_list)];
            }
        }

        // remove all occurrences of the library (exact match)
        const trimmedLib = String(library).trim();
        const filtered = list.filter(item => String(item).trim() !== trimmedLib);

        const now = new Date().toISOString();
        if (filtered.length === 0) {
            // delete the row to keep DB tidy
            db.run('DELETE FROM engword_selected WHERE username = ?', [username], function (delErr) {
                if (delErr) {
                    console.error('/api/engword/unselect-library DELETE error', delErr);
                    return res.status(500).json({ error: delErr.message });
                }
                return res.json({ success: true, selectedList: [] });
            });
        } else {
            const serialized = JSON.stringify(filtered);
            db.run('UPDATE engword_selected SET selected_list = ?, updated_at = ? WHERE username = ?', [serialized, now, username], function (upErr) {
                if (upErr) {
                    console.error('/api/engword/unselect-library UPDATE error', upErr);
                    return res.status(500).json({ error: upErr.message });
                }
                return res.json({ success: true, selectedList: filtered, selected: filtered[0] || '' });
            });
        }
    });
});

// ====== 新童行单词记忆系统结束 ======

// ----------------- 新增：口语训练临时音频目录及表和 API 开始 -----------------
const oralAudioTempDir = path.join(__dirname, 'oral', 'audiosource', 'oralaudiotemp');
if (!fs.existsSync(oralAudioTempDir)) {
    fs.mkdirSync(oralAudioTempDir, { recursive: true });
}
// 静态访问口语临时音频
app.use('/oral/audiosource/oralaudiotemp', express.static(oralAudioTempDir));

// 新建 oral_practice 表（用于保存每次关卡完成的记录）
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS oral_practice (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        training_key TEXT NOT NULL,    -- 如 'camb1A'
        level INTEGER NOT NULL,
        records TEXT NOT NULL,        -- JSON 字符串，包含每句原文、识别结果、星级等
        files TEXT,                   -- JSON 字符串，保存已复制到 oralaudiotemp 的文件名数组
        star_overall INTEGER,         -- 可选：本关整体星级（0-5）
        completed_at TEXT,            -- ISO UTC
        completed_beijing TEXT,       -- 北京时间可读字符串
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// POST /api/oral-practice/submit
// body: {
//   username, training_key, level,
//   records: [{ sentence: "...", recognizedText: "...", stars: 0..5 }, ...],
//   tempFiles: ["temp_xxx.wav", ...]   // 来自 /homework/audio_temp 的临时文件名（可为空数组）
// }
app.post('/api/oral-practice/submit', async (req, res) => {
    try {
        const { username, training_key, level, records, tempFiles } = req.body || {};

        if (!username || !training_key || typeof level === 'undefined' || !Array.isArray(records)) {
            return res.status(400).json({ success: false, error: '参数不完整，需 username, training_key, level, records' });
        }

        // 1. 处理音频文件移动：从 homework/audio_temp 移动到 oral/audiosource/oralaudiotemp
        const savedFiles = [];
        if (Array.isArray(tempFiles) && tempFiles.length > 0) {
            const srcDir = path.join(__dirname, 'homework', 'audio_temp');
            const destDir = path.join(__dirname, 'oral', 'audiosource', 'oralaudiotemp');
            
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }

            for (const filename of tempFiles) {
                if (!filename) continue;
                const srcPath = path.join(srcDir, filename);
                const destPath = path.join(destDir, filename);
                
                try {
                    if (fs.existsSync(srcPath)) {
                        // 使用 copyFile 而不是 rename，防止跨分区移动失败
                        await fs.promises.copyFile(srcPath, destPath);
                        savedFiles.push(filename);
                        // 可选：复制后删除原文件
                        // await fs.promises.unlink(srcPath).catch(()=>{});
                    } else {
                        console.warn(`[OralSubmit] 临时文件不存在: ${srcPath}`);
                    }
                } catch (e) {
                    console.error(`[OralSubmit] 移动音频文件失败: ${filename}`, e);
                }
            }
        }

        // 2. 计算整体星级（取平均值）
        let starOverall = 0;
        if (records.length > 0) {
            const totalStars = records.reduce((sum, r) => sum + (Number(r.stars) || 0), 0);
            // 平均分四舍五入
            starOverall = Math.round((totalStars / records.length) * 10) / 10; 
        }

        // 3. 构造时间
        const now = new Date();
        const completedAt = now.toISOString();
        // 北京时间字符串 YYYY-MM-DD HH:mm:ss
        const completedBeijing = new Date(now.getTime() + 8 * 60 * 60 * 1000)
            .toISOString().replace('T', ' ').slice(0, 19);

        // 4. 写入数据库
        db.run(
            `INSERT INTO oral_practice (
                username, training_key, level, records, files, star_overall, completed_at, completed_beijing
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                username, 
                training_key, 
                level, 
                JSON.stringify(records), 
                JSON.stringify(savedFiles), 
                starOverall, 
                completedAt, 
                completedBeijing
            ],
            function(err) {
                if (err) {
                    console.error('[OralSubmit] 数据库写入失败:', err);
                    return res.status(500).json({ success: false, error: err.message });
                }
                res.json({ success: true, id: this.lastID });
            }
    );

} catch (err) {
    console.error('[OralSubmit] 处理异常:', err);
    res.status(500).json({ success: false, error: err.message });
}
});

// GET /api/oral-practice/list?training_key=...&username=...
// 返回该训练项（training_key）下所有记录，按时间降序；可加 username 过滤
app.get('/api/oral-practice/list', (req, res) => {
    const { training_key, username } = req.query;
    if (!training_key) return res.status(400).json({ success:false, error: 'training_key 必需' });
    let sql = `SELECT id, username, training_key, level, records, files, star_overall, completed_at, completed_beijing, created_at FROM oral_practice WHERE training_key = ?`;
    const params = [training_key];
    if (username) {
        sql += ` AND username = ?`;
        params.push(username);
    }
    sql += ` ORDER BY created_at DESC`;
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        const out = (rows || []).map(r => ({
            id: r.id,
            username: r.username,
            training_key: r.training_key,
            level: r.level,
            records: safeParseJson(r.records),
            files: safeParseJson(r.files),
            star_overall: r.star_overall,
            completed_at: r.completed_at,
            completed_beijing: r.completed_beijing,
            created_at: r.created_at
        }));
        res.json({ success: true, records: out });
    });
});

// GET /api/oral-practice/:id  获取单条记录详情
app.get('/api/oral-practice/record', (req, res) => {
    const id = req.query.id || req.query.recordId;
    if (!id) return res.status(400).json({ success:false, error: 'id 必需' });
    db.get(`SELECT * FROM oral_practice WHERE id = ?`, [id], (err, row) => {
        if (err) return res.status(500).json({ success:false, error: err.message });
        if (!row) return res.status(404).json({ success:false, error: '未找到记录' });
        res.json({
            success: true,
            record: {
                id: row.id,
                username: row.username,
                training_key: row.training_key,
                level: row.level,
                records: safeParseJson(row.records),
                files: safeParseJson(row.files),
                star_overall: row.star_overall,
                completed_at: row.completed_at,
                completed_beijing: row.completed_beijing,
                created_at: row.created_at
            }
        });
    });
});

// 新增：获取所有训练项及记录数
app.get('/api/oral-practice/training-projects', (req, res) => {
    const sql = `
        SELECT training_key, COUNT(*) as count
        FROM oral_practice
        WHERE datetime(created_at) >= datetime('now','-30 days')
        GROUP BY training_key
        ORDER BY training_key ASC
    `;
    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('/api/oral-practice/training-projects 错误:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, projects: rows || [] });
    });
});

// 每天凌晨清理 oral_practice 表中过期（30天前）的记录
function cleanOldOralPracticeRecords() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString();
    db.run(
        `DELETE FROM oral_practice WHERE created_at < ?`,
        [cutoffStr],
        function(err) {
            if (err) {
                console.error('[口语训练清理] 删除30天前记录失败:', err.message);
            } else {
                console.log('[口语训练清理] 已清理30天前口语训练记录:', this.changes);
            }
        }
    );
}

// 设置每天凌晨自动清理
function scheduleOralPracticeCleanup() {
    // 计算距离下一个凌晨的毫秒数
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0);
    const msUntilMidnight = nextMidnight.getTime() - now.getTime();
    setTimeout(() => {
        cleanOldOralPracticeRecords();
        setInterval(cleanOldOralPracticeRecords, 24 * 60 * 60 * 1000); // 之后每天执行
    }, msUntilMidnight);
}

// 服务启动时调用
scheduleOralPracticeCleanup();
// ----------------- 新增：口语训练临时音频目录及表和 API 结束 -----------------

// ============================================================
// ========== 单词荣耀排位赛数据存储功能 开始 ==========
// ============================================================

// 1. 初始化数据库表：存储玩家排位赛比赛记录
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS glory_race_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        rank_level TEXT NOT NULL,
        star_before INTEGER NOT NULL,
        star_after INTEGER NOT NULL,
        word_timings TEXT NOT NULL,
        total_word_time INTEGER,
        character_name TEXT,
        player_rank TEXT,
        completed_at TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // 创建索引以便快速查询和清理
    db.run(`CREATE INDEX IF NOT EXISTS idx_glory_race_user_rank_star 
            ON glory_race_records(user_id, rank_level, star_before, star_after)`);
    
    db.run(`CREATE INDEX IF NOT EXISTS idx_glory_race_user_completed 
            ON glory_race_records(user_id, completed_at DESC)`);
    
    // 为旧数据库添加 character_name 字段（兼容性更新）
    db.run(`ALTER TABLE glory_race_records ADD COLUMN character_name TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('[单词荣耀] 添加 character_name 字段失败:', err.message);
        }
    });
    
    // 为旧数据库添加 total_word_time 字段（兼容性更新）
    db.run(`ALTER TABLE glory_race_records ADD COLUMN total_word_time INTEGER`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('[单词荣耀] 添加 total_word_time 字段失败:', err.message);
        }
    });
    
    // 为旧数据库添加 player_rank 字段（兼容性更新）
    db.run(`ALTER TABLE glory_race_records ADD COLUMN player_rank TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('[单词荣耀] 添加 player_rank 字段失败:', err.message);
        }
        // 字段添加成功，不再输出提示信息
    });
});

// 2. 提交比赛记录接口（角色信息自动从最新记录中读取）
// 新增：段位晋升映射表
const RANK_PROGRESSION_MAP = {
    '青铜一阶': '青铜二阶',
    '青铜二阶': '白银一阶',
    '白银一阶': '白银二阶',
    '白银二阶': '黄金一阶',
    '黄金一阶': '黄金二阶',
    '黄金二阶': '铂金一阶',
    '铂金一阶': '铂金二阶',
    '铂金二阶': '钻石一阶',
    '钻石一阶': '钻石二阶',
    '钻石二阶': '星耀一阶',
    '星耀一阶': '星耀二阶',
    '星耀二阶': '王者一阶',
    '王者一阶': '王者二阶',
    '王者二阶': '最强王者',
    '最强王者': null // 最强王者无下一段位
};

app.post('/api/glory-race/submit-record', (req, res) => {
    const { userId, username, rankLevel, starBefore, starAfter, wordTimings, totalWordTime, completedAt, playerRank } = req.body;
    
    // 参数验证（增加 totalWordTime 参数）
    if (!userId || !username || !rankLevel || starBefore === undefined || starAfter === undefined || !wordTimings || !completedAt) {
        return res.status(400).json({ 
            success: false, 
            error: '参数缺失：需要 userId, username, rankLevel, starBefore, starAfter, wordTimings, completedAt' 
        });
    }
    
    // 验证 wordTimings 格式（应该是数组）
    if (!Array.isArray(wordTimings)) {
        return res.status(400).json({ 
            success: false, 
            error: 'wordTimings 必须是数组格式' 
        });
    }
    
    // 将 wordTimings 转换为 JSON 字符串存储
    const wordTimingsJson = JSON.stringify(wordTimings);
    
    // totalWordTime 可选，兼容旧数据
    const totalWordTimeValue = (totalWordTime !== undefined && totalWordTime !== null) ? parseInt(totalWordTime) : null;
    
    // 查询该用户最新记录中的角色信息（自动填充）
    db.get(
        `SELECT character_name FROM glory_race_records 
         WHERE user_id = ? 
         ORDER BY completed_at DESC 
         LIMIT 1`,
        [userId],
        (err, row) => {
            // 使用最新记录的角色，如果没有则使用默认值 'cat'
            const characterName = (row && row.character_name) ? row.character_name : 'cat';
            
            // 插入新记录（包含 total_word_time 和 player_rank）
            db.run(
                `INSERT INTO glory_race_records 
                (user_id, username, rank_level, star_before, star_after, word_timings, total_word_time, character_name, player_rank, completed_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, username, rankLevel, starBefore, starAfter, wordTimingsJson, totalWordTimeValue, characterName, playerRank || null, completedAt],
                function(insertErr) {
                    if (insertErr) {
                        console.error('[单词荣耀] 插入比赛记录失败:', insertErr.message);
                        return res.status(500).json({ success: false, error: insertErr.message });
                    }
                    
                    const insertedId = this.lastID;
                    console.log(`[单词荣耀] 插入比赛记录成功: ID=${insertedId}, 用户=${username}, 段位=${rankLevel}, ${starBefore}星→${starAfter}星, 名次=${playerRank || '未知'}, 总用时=${totalWordTimeValue}ms, 角色=${characterName}（自动填充）`);
            
                    // 清理旧记录，只保留最近5次（针对同一用户、同一段位、同一星级变化）
                    cleanOldGloryRecords(userId, rankLevel, starBefore, starAfter, (cleanErr) => {
                        if (cleanErr) {
                            console.error('[单词荣耀] 清理旧记录失败:', cleanErr.message);
                            // 即使清理失败也返回成功，因为主记录已插入
                        }
                        
                        res.json({ 
                            success: true, 
                            recordId: insertedId,
                            message: '比赛记录已保存' 
                        });
                    });
                }
            );
        }
    );
});

// 3. 清理旧记录的工具函数（保留最近5次）
function cleanOldGloryRecords(userId, rankLevel, starBefore, starAfter, callback) {
    // 查询该用户、该段位、该星级变化的所有记录，按完成时间降序
    db.all(
        `SELECT id FROM glory_race_records 
        WHERE user_id = ? AND rank_level = ? AND star_before = ? AND star_after = ? 
        ORDER BY completed_at DESC`,
        [userId, rankLevel, starBefore, starAfter],
        (err, rows) => {
            if (err) {
                return callback(err);
            }
            
            // 如果记录数量超过5条，删除最旧的记录
            if (rows.length > 5) {
                const idsToDelete = rows.slice(5).map(row => row.id);
                const placeholders = idsToDelete.map(() => '?').join(',');
                
                db.run(
                    `DELETE FROM glory_race_records WHERE id IN (${placeholders})`,
                    idsToDelete,
                    function(delErr) {
                        if (delErr) {
                            return callback(delErr);
                        }
                        console.log(`[单词荣耀] 清理旧记录: 用户=${userId}, 段位=${rankLevel}, ${starBefore}→${starAfter}星, 删除${this.changes}条`);
                        callback(null);
                    }
                );
            } else {
                callback(null);
            }
        }
    );
}

// 4. 获取玩家最新星级接口
app.get('/api/glory-race/latest-stars', (req, res) => {
    const { userId, username } = req.query;
    
    if (!userId && !username) {
        return res.status(400).json({ 
            success: false, 
            error: '需要提供 userId 或 username' 
        });
    }
    
    // 构建查询条件
    let query = 'SELECT rank_level, star_after, character_name, completed_at FROM glory_race_records WHERE ';
    let params = [];
    
    if (userId) {
        query += 'user_id = ?';
        params.push(userId);
    } else {
        query += 'username = ?';
        params.push(username);
    }
    
    query += ' ORDER BY completed_at DESC LIMIT 1';
    
    db.get(query, params, (err, row) => {
        if (err) {
            console.error('[单词荣耀] 查询最新星级失败:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        if (!row) {
            // 没有记录，返回默认值（青铜一阶0星，默认cat角色）
            return res.json({ 
                success: true, 
                hasRecord: false,
                rankLevel: '青铜一阶',
                starCount: 0,
                characterName: null,
                completedAt: null
            });
        }
        
        res.json({ 
            success: true, 
            hasRecord: true,
            rankLevel: row.rank_level,
            starCount: row.star_after,
            characterName: row.character_name || null,
            completedAt: row.completed_at
        });
    });
});

// 5. 获取玩家特定段位星级的历史记录（用于数据分析，可选）
app.get('/api/glory-race/records', (req, res) => {
    const { userId, username, rankLevel, starBefore, starAfter, limit = 5 } = req.query;
    
    if (!userId && !username) {
        return res.status(400).json({ 
            success: false, 
            error: '需要提供 userId 或 username' 
        });
    }
    
    let query = 'SELECT * FROM glory_race_records WHERE ';
    let params = [];
    
    if (userId) {
        query += 'user_id = ?';
        params.push(userId);
    } else {
        query += 'username = ?';
        params.push(username);
    }
    
    if (rankLevel) {
        query += ' AND rank_level = ?';
        params.push(rankLevel);
    }
    
    if (starBefore !== undefined) {
        query += ' AND star_before = ?';
        params.push(starBefore);
    }
    
    if (starAfter !== undefined) {
        query += ' AND star_after = ?';
        params.push(starAfter);
    }
    
    query += ' ORDER BY completed_at DESC LIMIT ?';
    params.push(parseInt(limit) || 5);
    
    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('[单词荣耀] 查询历史记录失败:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        // 解析 word_timings JSON 字符串
        const records = rows.map(row => ({
            ...row,
            word_timings: JSON.parse(row.word_timings)
        }));
        
        res.json({ 
            success: true, 
            records: records,
            count: records.length
        });
    });
});

// 新增：保存玩家角色选择接口（独立于比赛记录）
app.post('/api/glory-race/save-character', (req, res) => {
    const { userId, username, characterName } = req.body;
    
    // 参数验证
    if (!userId || !username || !characterName) {
        return res.status(400).json({ 
            success: false, 
            error: '参数缺失：需要 userId, username, characterName' 
        });
    }
    
    // 查询该用户最新的一条记录
    db.get(
        `SELECT id FROM glory_race_records 
         WHERE user_id = ? 
         ORDER BY completed_at DESC 
         LIMIT 1`,
        [userId],
        (err, row) => {
            if (err) {
                console.error('[单词荣耀] 查询用户记录失败:', err.message);
                return res.status(500).json({ success: false, error: err.message });
            }
            
            if (row) {
                // 如果有记录，则更新最新记录的角色信息
                db.run(
                    `UPDATE glory_race_records 
                     SET character_name = ? 
                     WHERE id = ?`,
                    [characterName, row.id],
                    function(updateErr) {
                        if (updateErr) {
                            console.error('[单词荣耀] 更新角色失败:', updateErr.message);
                            return res.status(500).json({ success: false, error: updateErr.message });
                        }
                        
                        console.log(`[单词荣耀] 更新角色成功: ${username} -> ${characterName}`);
                        res.json({ 
                            success: true, 
                            message: '角色保存成功',
                            characterName: characterName
                        });
                    }
                );
            } else {
                // 如果没有历史记录，创建一条新的初始记录（只保存角色，其他字段为默认值）
                db.run(
                    `INSERT INTO glory_race_records 
                     (user_id, username, rank_level, star_before, star_after, word_timings, character_name, completed_at) 
                     VALUES (?, ?, '青铜一阶', 0, 0, '[]', ?, datetime('now'))`,
                    [userId, username, characterName],
                    function(insertErr) {
                        if (insertErr) {
                            console.error('[单词荣耀] 插入初始角色记录失败:', insertErr.message);
                            return res.status(500).json({ success: false, error: insertErr.message });
                        }
                        
                        console.log(`[单词荣耀] 创建初始角色记录成功: ${username} -> ${characterName}`);
                        res.json({ 
                            success: true, 
                            message: '角色保存成功（创建初始记录）',
                            characterName: characterName
                        });
                    }
                );
            }
        }
    );
});

// 6. 匹配相同段位星级的其他真实玩家记录（每个玩家根据策略选择一条记录）
app.get('/api/glory-race/match-players', (req, res) => {
    const { userId, rankLevel, starCount, matchStrategy } = req.query;
    
    if (!rankLevel || starCount === undefined) {
        return res.status(400).json({ 
            success: false, 
            error: '需要提供 rankLevel 和 starCount' 
        });
    }
    
    // matchStrategy: 'shortest' | 'longest' | 'normal' (默认)
    const strategy = matchStrategy || 'normal';
    
    // 查询与当前玩家段位星级相同的其他玩家的所有记录（包含角色信息和总用时）
    // star_before 为当前星级，因为我们要匹配即将开始的比赛
    let query = `
        SELECT user_id, username, word_timings, total_word_time, character_name, completed_at 
        FROM glory_race_records 
        WHERE rank_level = ? AND star_before = ?
    `;
    let params = [rankLevel, parseInt(starCount)];
    
    // 如果提供了 userId，排除当前用户自己的记录
    if (userId) {
        query += ' AND user_id != ?';
        params.push(userId);
    }
    
    // 按完成时间倒序排列（获取所有记录，不分组）
    query += ' ORDER BY completed_at DESC';
    
    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('[单词荣耀] 匹配玩家失败:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        // 按 user_id 分组
        const playerRecordsMap = {};
        rows.forEach(row => {
            if (!playerRecordsMap[row.user_id]) {
                playerRecordsMap[row.user_id] = [];
            }
            playerRecordsMap[row.user_id].push({
                userId: row.user_id,
                username: row.username,
                wordTimings: JSON.parse(row.word_timings),
                totalWordTime: row.total_word_time, // 可能为null（旧数据）
                characterName: row.character_name || 'cat',
                completedAt: row.completed_at
            });
        });
        
        // 从每个玩家的记录中根据策略选择一条
        const selectedPlayers = [];
        Object.keys(playerRecordsMap).forEach(uid => {
            const records = playerRecordsMap[uid];
            let selectedRecord;
            
            if (strategy === 'shortest') {
                // 选择总用时最短的记录（提高难度）
                // 过滤掉没有totalWordTime的记录，如果全都没有则随机选
                const withTime = records.filter(r => r.totalWordTime !== null && r.totalWordTime !== undefined);
                if (withTime.length > 0) {
                    selectedRecord = withTime.reduce((min, r) => 
                        (r.totalWordTime < min.totalWordTime) ? r : min
                    );
                } else {
                    // 兼容旧数据：没有totalWordTime则随机选
                    selectedRecord = records[Math.floor(Math.random() * records.length)];
                }
            } else if (strategy === 'longest') {
                // 选择总用时最长的记录（降低难度）
                const withTime = records.filter(r => r.totalWordTime !== null && r.totalWordTime !== undefined);
                if (withTime.length > 0) {
                    selectedRecord = withTime.reduce((max, r) => 
                        (r.totalWordTime > max.totalWordTime) ? r : max
                    );
                } else {
                    // 兼容旧数据：没有totalWordTime则随机选
                    selectedRecord = records[Math.floor(Math.random() * records.length)];
                }
            } else {
                // normal策略：随机选择
                selectedRecord = records[Math.floor(Math.random() * records.length)];
            }
            
            selectedPlayers.push(selectedRecord);
        });
        
        // 随机打乱玩家顺序，并限制最多返回20个玩家
        const shuffledPlayers = selectedPlayers.sort(() => Math.random() - 0.5);
        const finalPlayers = shuffledPlayers.slice(0, 20);
        
        console.log(`[单词荣耀] 匹配策略=${strategy}, 匹配到 ${Object.keys(playerRecordsMap).length} 位玩家，共 ${rows.length} 条记录，返回 ${finalPlayers.length} 位`);
        
        res.json({ 
            success: true, 
            players: finalPlayers,
            count: finalPlayers.length
        });
    });
});

// 7. 获取单词荣耀排行榜（按最高段位和星级排名，返回前50名）
app.get('/api/glory-race/leaderboard', (req, res) => {
    // 定义段位优先级映射（数字越大排名越高）
    const RANK_PRIORITY = {
        '最强王者': 14,
        '王者二阶': 13,
        '王者一阶': 12,
        '星耀二阶': 11,
        '星耀一阶': 10,
        '钻石二阶': 9,
        '钻石一阶': 8,
        '铂金二阶': 7,
        '铂金一阶': 6,
        '黄金二阶': 5,
        '黄金一阶': 4,
        '白银二阶': 3,
        '白银一阶': 2,
        '青铜二阶': 1,
        '青铜一阶': 0
    };
    
    // 查询所有玩家的所有比赛记录
    const query = `
        SELECT user_id, username, rank_level, star_after, character_name, completed_at 
        FROM glory_race_records 
        ORDER BY completed_at DESC
    `;
    
    db.all(query, [], (err, rows) => {
        if (err) {
            console.error('[单词荣耀排行榜] 查询失败:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        // 按玩家分组，找出每个玩家的最高段位和星级
        const playerMaxRanks = {};
        
        rows.forEach(row => {
            const userId = row.user_id;
            const rankPriority = RANK_PRIORITY[row.rank_level] || 0;
            const starCount = row.star_after || 0;
            
            if (!playerMaxRanks[userId]) {
                playerMaxRanks[userId] = {
                    userId: userId,
                    username: row.username,
                    rankLevel: row.rank_level,
                    starCount: starCount,
                    rankPriority: rankPriority,
                    characterName: row.character_name || 'cat',
                    completedAt: row.completed_at
                };
            } else {
                const current = playerMaxRanks[userId];
                // 比较段位优先级，如果段位相同则比较星级
                if (rankPriority > current.rankPriority || 
                    (rankPriority === current.rankPriority && starCount > current.starCount)) {
                    playerMaxRanks[userId] = {
                        userId: userId,
                        username: row.username,
                        rankLevel: row.rank_level,
                        starCount: starCount,
                        rankPriority: rankPriority,
                        characterName: row.character_name || 'cat',
                        completedAt: row.completed_at
                    };
                }
            }
        });
        
        // 转换为数组并排序
        const leaderboard = Object.values(playerMaxRanks)
            .sort((a, b) => {
                // 先按段位优先级降序排列
                if (b.rankPriority !== a.rankPriority) {
                    return b.rankPriority - a.rankPriority;
                }
                // 段位相同则按星级降序排列
                return b.starCount - a.starCount;
            })
            .slice(0, 50) // 只返回前50名
            .map((player, index) => ({
                rank: index + 1,
                userId: player.userId,
                username: player.username,
                rankLevel: player.rankLevel,
                starCount: player.starCount,
                characterName: player.characterName,
                completedAt: player.completedAt
            }));
        
        console.log(`[单词荣耀排行榜] 查询成功，共 ${Object.keys(playerMaxRanks).length} 位玩家，返回前 ${leaderboard.length} 名`);
        
        res.json({ 
            success: true, 
            leaderboard: leaderboard,
            totalPlayers: Object.keys(playerMaxRanks).length,
            count: leaderboard.length
        });
    });
});

// API：获取玩家战绩数据
app.get('/api/glory-race/player-history', (req, res) => {
    const { userId, username } = req.query;
    
    if (!userId && !username) {
        return res.status(400).json({ 
            success: false, 
            error: '必须提供 userId 或 username 参数' 
        });
    }
    
    // 定义段位优先级映射（用于计算最高段位）
    const RANK_PRIORITY = {
        '最强王者': 14,
        '王者二阶': 13,
        '王者一阶': 12,
        '星耀二阶': 11,
        '星耀一阶': 10,
        '钻石二阶': 9,
        '钻石一阶': 8,
        '铂金二阶': 7,
        '铂金一阶': 6,
        '黄金二阶': 5,
        '黄金一阶': 4,
        '白银二阶': 3,
        '白银一阶': 2,
        '青铜二阶': 1,
        '青铜一阶': 0
    };
    
    // 构建查询条件
    let whereClause = '';
    let params = [];
    
    if (userId) {
        whereClause = 'user_id = ?';
        params.push(userId);
    } else {
        whereClause = 'username = ?';
        params.push(username);
    }
    
    // 查询该玩家的所有比赛记录
    const allRecordsQuery = `
        SELECT id, user_id, username, rank_level, star_before, star_after, 
               word_timings, total_word_time, character_name, player_rank, completed_at 
        FROM glory_race_records 
        WHERE ${whereClause}
        ORDER BY completed_at DESC
    `;
    
    db.all(allRecordsQuery, params, (err, allRows) => {
        if (err) {
            console.error('[单词荣耀战绩] 查询失败:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        if (!allRows || allRows.length === 0) {
            return res.json({ 
                success: true, 
                recentGames: [],
                highestRank: null,
                totalGames: 0,
                playerInfo: null
            });
        }
        
        // 找出最高段位
        let highestRank = null;
        let highestPriority = -1;
        let highestStars = 0;
        
        allRows.forEach(row => {
            const rankPriority = RANK_PRIORITY[row.rank_level] || 0;
            const stars = row.star_after || 0;
            
            if (rankPriority > highestPriority || 
                (rankPriority === highestPriority && stars > highestStars)) {
                highestPriority = rankPriority;
                highestStars = stars;
                highestRank = {
                    rankLevel: row.rank_level,
                    stars: stars,
                    achievedAt: row.completed_at
                };
            }
        });
        
        // 获取最近10场比赛记录
        const recentGames = allRows.slice(0, 10).map((row, index) => {
            let wordTimings = [];
            try {
                wordTimings = JSON.parse(row.word_timings || '[]');
            } catch (e) {
                console.error('[单词荣耀战绩] 解析 word_timings 失败:', e);
            }
            
            // 提取错误单词（correct为false的单词）
            const wrongWords = wordTimings
                .filter(w => w.correct === false || w.correct === 0)
                .map(w => ({
                    word: w.word,
                    meaning: w.meaning || '',
                    correct: w.correct || false,
                    time: w.time || 0
                }));
            
            // 计算星级变化
            const starChange = row.star_after - row.star_before;
            
            // 使用真实的名次数据（优先使用player_rank字段）
            let rank = row.player_rank || '未知';
            
            // 如果没有player_rank字段，则根据星级变化推断（兼容旧数据）
            if (!row.player_rank) {
                if (starChange > 0) {
                    rank = '第1名';
                } else if (starChange === 0) {
                    rank = '第2-3名';
                } else {
                    rank = '第4名';
                }
            }
            
            return {
                id: row.id,
                gameNumber: index + 1,
                rank: rank,
                rankLevel: row.rank_level,
                starBefore: row.star_before,
                starAfter: row.star_after,
                starChange: starChange,
                wrongWords: wrongWords,
                wrongWordCount: wrongWords.length,
                totalWordTime: row.total_word_time || 0,
                completedAt: row.completed_at,
                characterName: row.character_name || 'cat'
            };
        });
        
        // 玩家基本信息
        const playerInfo = {
            userId: allRows[0].user_id,
            username: allRows[0].username,
            characterName: allRows[0].character_name || 'cat'
        };
        
        console.log(`[单词荣耀战绩] 查询成功: 玩家=${playerInfo.username}, 总场次=${allRows.length}, 最高段位=${highestRank ? highestRank.rankLevel : '无'}`);
        
        res.json({ 
            success: true, 
            recentGames: recentGames,
            highestRank: highestRank,
            totalGames: allRows.length,
            playerInfo: playerInfo
        });
    });
});

// ============================================================
// ========== 单词荣耀排位赛数据存储功能 结束 ==========
// ============================================================

// ========== 单词荣耀玩家等级系统 ==========
// 玩家等级表：存储每个玩家的等级和连胜数据
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS glory_player_level (
        username TEXT PRIMARY KEY,
        level INTEGER DEFAULT 0,           -- 当前等级 (0-6)
        win_streak INTEGER DEFAULT 0,      -- 当前等级的连胜场数
        total_wins INTEGER DEFAULT 0,      -- 总胜场数
        total_matches INTEGER DEFAULT 0,   -- 总比赛场数
        last_updated TEXT,                 -- 最后更新时间
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
});

// 获取玩家等级信息
app.get('/api/glory/player-level/:username', (req, res) => {
    const { username } = req.params;
    if (!username) return res.status(400).json({ error: '缺少用户名' });
    
    db.get(
        `SELECT * FROM glory_player_level WHERE username = ?`,
        [username],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            // 如果没有记录，返回初始值
            if (!row) {
                return res.json({
                    username,
                    level: 0,
                    win_streak: 0,
                    total_wins: 0,
                    total_matches: 0,
                    last_updated: null
                });
            }
            res.json(row);
        }
    );
});

// 等级需求配置（每个等级需要的连胜场数）
const LEVEL_REQUIREMENTS = {
    0: 2,  // 0级升1级需要2连胜
    1: 3,  // 1级升2级需要3连胜
    2: 4,  // 2级升3级需要4连胜
    3: 5,  // 3级升4级需要5连胜
    4: 6,  // 4级升5级需要6连胜
    5: 7   // 5级升6级需要7连胜
};

// 更新玩家等级（根据比赛结果）
// rank: 1-5的排名，1-2算胜利，3-5算失败
app.post('/api/glory/player-level/update', (req, res) => {
    const { username, rank } = req.body;
    if (!username || !rank) {
        return res.status(400).json({ error: '缺少必要参数' });
    }
    
    const isWin = rank <= 2; // 前2名算胜利（最新规则：3、4、5名都算失败）
    const now = new Date().toISOString();
    
    // 先获取当前等级数据
    db.get(
        `SELECT * FROM glory_player_level WHERE username = ?`,
        [username],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            
            let currentLevel = row ? row.level : 0;
            let currentStreak = row ? row.win_streak : 0;
            let totalWins = row ? row.total_wins : 0;
            let totalMatches = row ? row.total_matches : 0;
            
            totalMatches++;
            
            let newLevel = currentLevel;
            let newStreak = currentStreak;
            
            if (isWin) {
                totalWins++;
                newStreak++;
                
                // 检查是否可以升级
                if (currentLevel < 6 && newStreak >= LEVEL_REQUIREMENTS[currentLevel]) {
                    newLevel++;
                    newStreak = 0; // 升级后连胜归零
                }
            } else {
                // 失败：降级到前一级，连胜归零
                if (currentLevel > 0) {
                    newLevel = currentLevel - 1;
                }
                newStreak = 0;
            }
            
            // 插入或更新记录
            db.run(
                `INSERT INTO glory_player_level (username, level, win_streak, total_wins, total_matches, last_updated)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(username) DO UPDATE SET
                 level = excluded.level,
                 win_streak = excluded.win_streak,
                 total_wins = excluded.total_wins,
                 total_matches = excluded.total_matches,
                 last_updated = excluded.last_updated`,
                [username, newLevel, newStreak, totalWins, totalMatches, now],
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    
                    res.json({
                        success: true,
                        username,
                        level: newLevel,
                        win_streak: newStreak,
                        total_wins: totalWins,
                        total_matches: totalMatches,
                        level_changed: newLevel !== currentLevel,
                        level_up: newLevel > currentLevel,
                        level_down: newLevel < currentLevel
                    });
                }
            );
        }
    );
});

// 批量获取多个玩家的等级信息
app.post('/api/glory/player-levels/batch', (req, res) => {
    const { usernames } = req.body;
    if (!Array.isArray(usernames) || usernames.length === 0) {
        return res.status(400).json({ error: '缺少用户名列表' });
    }
    
    const placeholders = usernames.map(() => '?').join(',');
    db.all(
        `SELECT * FROM glory_player_level WHERE username IN (${placeholders})`,
        usernames,
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            
            // 为没有记录的用户返回默认值
            const result = {};
            usernames.forEach(username => {
                const found = rows.find(r => r.username === username);
                result[username] = found || {
                    username,
                    level: 0,
                    win_streak: 0,
                    total_wins: 0,
                    total_matches: 0,
                    last_updated: null
                };
            });
            
            res.json(result);
        }
    );
});
// ========== 单词荣耀玩家等级系统结束 ==========

// --- WebSocket 房间与多人训练后端逻辑开始 ---
// 需要在文件顶部已有 `const WebSocket = require('ws');` 的基础上使用 http
const http = require('http');

// --- WebSocket 房间与多人训练后端逻辑开始 ---

// 管理员账号列表（可手动添加新账号）
const ADMIN_ACCOUNTS = ['小谢', '小宋'];

// 判断是否为管理员账号
function isAdminAccount(name) {
    return typeof name === 'string' && ADMIN_ACCOUNTS.includes(name.trim());
}
// 辅助函数：获取房间中的活跃成员列表（过滤掉观众和管理员）
function getRoomActiveMembers(room) {
    if (!room || !room.members) return [];
    return Object.entries(room.members)
        .filter(([_, m]) => !m.isViewer)
        .filter(([uname]) => !isAdminAccount(uname))
        .map(([uname]) => uname);
}
// 内存存储房间（简单实现，进程重启会丢失）
const wordClassRooms = {}; 
// room structure:
// {
//   owner: 'alice',                // first joined username
//   members: { username: { ws, joinedAt } }, // live websocket connections
//   batch: { name: 'batch1', words: ['apple','banana', ...] }, // 可由客户端推送
//   started: false,
//   sequence: [], // randomized sequence of words for this session
//   state: { currentIndex: 0, answered: {} } // answered per word etc.
// }

function createRoomIfNotExists(code) {
  if (!wordClassRooms[code]) {
    wordClassRooms[code] = { 
      owner: null, 
      members: {},  // 普通玩家
      admins: {},   // 新增：管理员连接
      batch: null, 
      mode: 'eng-chn',
      started: false, 
      sequence: [], 
      state: { currentIndex:0, answered: {} } 
    };
  }
}

// helper: broadcast JSON to all members in room (including admins)
function broadcastRoom(code, payload) {
  const room = wordClassRooms[code];
  if (!room) return;
  
  // 发送给普通成员
  Object.values(room.members).forEach(m => {
    try { m.ws.send(JSON.stringify(payload)); } catch(e) {}
  });
  
  // 同时发送给管理员
  Object.values(room.admins || {}).forEach(a => {
    try { a.ws.send(JSON.stringify(payload)); } catch(e) {}
  });
}

// 排除版广播：转发消息到房间所有成员，但排除发送者（避免回声）
function broadcastToRoom(code, msg, excludeWs) {
  const room = wordClassRooms[code];
  if (!room) return;
  const s = typeof msg === 'string' ? msg : JSON.stringify(msg);
  Object.values(room.members).forEach(m => {
    try {
      if (m && m.ws && m.ws.readyState === WebSocket.OPEN && m.ws !== excludeWs) {
        m.ws.send(s);
      }
    } catch (e) {
      console.warn('broadcastToRoom 发送失败', e);
    }
  });
}

// compute ranking from room.state.answered: { username: { correctCount, totalTime, answersCount } }
function computeRanking(room) {
  const scores = [];
  const answered = room.state.answered || {};
  Object.entries(answered).forEach(([username, st]) => {
    // 过滤掉管理员账号
    if (isAdminAccount(username)) return;
    
    const accuracy = st.answersCount ? (st.correctCount / st.answersCount) : 0;
    scores.push({ username, correctCount: st.correctCount || 0, answersCount: st.answersCount || 0, totalTime: st.totalTime || 0, accuracy });
  });
  // sort: accuracy desc, then totalTime asc
  scores.sort((a,b) => {
    if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
    if (a.totalTime !== b.totalTime) return a.totalTime - b.totalTime;
    return b.correctCount - a.correctCount;
  });
  return scores;
}

// 创建 http server 并挂载 ws
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// keepalive pong
wss.on('connection', function connection(ws, req) {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  // 元信息
  ws._meta = { username: null, roomCode: null };

  // helper: safe JSON send
  function safeSend(socket, obj) {
    try { socket.send(JSON.stringify(obj)); } catch (e) {}
  }

  ws.on('message', msg => {
    let data;
    try { data = JSON.parse(String(msg)); } catch (e) { return; }
    const t = data.type;
    const username = data.username || (ws._meta && ws._meta.username) || null;
    const roomCodeRaw = data.roomCode || (ws._meta && ws._meta.roomCode) || '';
    const roomCode = String(roomCodeRaw || '').trim().toLowerCase();

    // --- 客户端向服务器转发并希望服务器广播到房间其它客户端的消息（排除来源 ws） ---
    // 这些类型通常由前端主动发送（room_update, ranking, ranking_update, started, reset 等）
    if (t === 'room_update' || t === 'ranking' || t === 'ranking_update' || t === 'started' || t === 'reset') {
    if (roomCode) createRoomIfNotExists(roomCode);
    if (username) ws._meta.username = username;
    if (roomCode) ws._meta.roomCode = roomCode;
    
    // 转发给房间其他成员（排除发送者 ws），阻断回声
    broadcastToRoom(roomCode, data, ws);
    return; // 不再继续执行后续逻辑
    }

    // JOIN
    if (t === 'join') {
      if (!username || !roomCode) return safeSend(ws, { type:'error', message:'缺少 username 或 roomCode' });
      createRoomIfNotExists(roomCode);
      const room = wordClassRooms[roomCode];
      
      // 检测是否为临时观众（用户名包含 __rankrace_viewer__）
      const isViewer = username.includes('__rankrace_viewer__');
      
      // 检测是否为管理员账号
      const isAdmin = isAdminAccount(username);
      
      // 设置房主逻辑
      if (isAdmin) {
        // 管理员强制成为房主（优先级最高）
        room.owner = username;
        console.log(`[房间 ${roomCode}] 管理员 ${username} 加入，强制设为房主`);
      } else if (!room.owner && !isViewer) {
        // 普通情况：第一个非观众用户成为房主
        room.owner = username;
      }
      
      // 将用户加入相应的列表
      if (isAdmin) {
        // 管理员加入 admins（可以接收消息但不参与游戏）
        room.admins = room.admins || {};
        room.admins[username] = { ws, joinedAt: new Date().toISOString() };
      } else {
        // 普通用户加入 members
        room.members[username] = { ws, joinedAt: new Date().toISOString(), isViewer };
      }
      
      ws._meta.username = username;
      ws._meta.roomCode = roomCode;
      ws._meta.isViewer = isViewer;
      ws._meta.isAdmin = isAdmin;
      
      // ensure room.state structures exist
      room.state = room.state || { currentIndex: 0, answered: {}, perIndexAnswered: {}, autoNextTimer: null };
      
      // 广播时过滤掉观众和管理员
      const activeMembers = getRoomActiveMembers(room);
      
      safeSend(ws, { type:'room_state', roomCode, owner: room.owner, batch: room.batch, mode: room.mode || 'eng-chn', started: room.started, members: activeMembers });
      broadcastRoom(roomCode, { type:'room_update', roomCode, members: activeMembers, owner: room.owner, batch: room.batch, mode: room.mode || 'eng-chn', started: room.started });
      return;
    }

    // LEAVE
    if (t === 'leave') {
      if (!username || !roomCode) return;
      const room = wordClassRooms[roomCode];
      if (!room) return;
      
      const memberInfo = room.members[username];
      const isAdmin = isAdminAccount(username);
      
      // 从 members 或 admins 中删除
      delete room.members[username];
      if (isAdmin && room.admins) {
        delete room.admins[username];
      }
      
      // 清理该玩家的统计数据
      if (room.state && room.state.answered) {
        delete room.state.answered[username];
      }

      // 只有非观众且非管理员离开时才需要重新分配房主
      if (room.owner === username && (!memberInfo || !memberInfo.isViewer) && !isAdmin) {
        const nonViewerMembers = Object.entries(room.members)
          .filter(([_, m]) => !m.isViewer)
          .filter(([uname]) => !isAdminAccount(uname))
          .map(([uname]) => uname);
        room.owner = nonViewerMembers.length ? nonViewerMembers[0] : null;
        console.log(`[房间 ${roomCode}] 房主离开，新房主: ${room.owner || '无'}`);
      }
      
      // 广播时过滤掉观众和管理员
      const activeMembers = getRoomActiveMembers(room);
      
      broadcastRoom(roomCode, { type:'room_update', roomCode, members: activeMembers, owner: room.owner, batch: room.batch, mode: room.mode || 'eng-chn', started: room.started });
      // 清理统计数据后，如果训练进行中则重新广播排行榜
      if (room.started && room.state && room.state.answered) {
        const ranking = computeRanking(room);
        broadcastRoom(roomCode, { type:'ranking', roomCode, ranking });
      }
      return;
    }

    // SET BATCH
    if (t === 'set_batch') {
      if (!roomCode || !data.batch || !Array.isArray(data.batch.words)) return safeSend(ws, { type:'error', message:'参数缺失或格式错误' });
      createRoomIfNotExists(roomCode);
      const room = wordClassRooms[roomCode];
      room.batch = { name: data.batch.name || (data.batch.words[0]||''), words: data.batch.words.slice() };
      room.started = false;
      room.sequence = [];
      room.state = { currentIndex: 0, answered: {}, perIndexAnswered: {}, autoNextTimer: null };
      // 保持现有 mode 不变
      broadcastRoom(roomCode, { type:'batch_updated', roomCode, batch: room.batch, mode: room.mode || 'eng-chn' });
      return;
    }

    // START
    if (t === 'start') {
      if (!roomCode) return;
      createRoomIfNotExists(roomCode);
      const room = wordClassRooms[roomCode];
      if (room.owner && room.owner !== username) return safeSend(ws, { type:'error', message:'只有房主可以开始训练' });
      if (!room.batch || !Array.isArray(room.batch.words) || room.batch.words.length === 0) return safeSend(ws, { type:'error', message:'未设置词库' });
      if (room.started) return; // 已开始则忽略

      // prepare sequence (prefer provided)
      let seq = Array.isArray(data.sequence) && data.sequence.length ? data.sequence.slice() : room.batch.words.slice();
      if (seq.length && typeof seq[0] === 'string') {
        const mapBySeq = {};
        (room.batch.words || []).forEach(w => { if (w && w.seq) mapBySeq[w.seq] = w; });
        seq = seq.map(s => mapBySeq[s] || null).filter(Boolean);
      }
      // shuffle
      for (let i = seq.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [seq[i], seq[j]] = [seq[j], seq[i]];
      }

      room.sequence = seq;
      room.started = true;
      room.state = { currentIndex: 0, answered: {}, perIndexAnswered: {}, autoNextTimer: null };

      broadcastRoom(roomCode, { type:'started', roomCode, sequenceLen: seq.length, batchName: room.batch?.name || '', sequence: room.sequence, mode: room.mode || 'eng-chn' });

      if (room.sequence.length > 0) {
        broadcastRoom(roomCode, { type:'next_word', roomCode, index: 0, word: room.sequence[0] });
      } else {
        room.started = false;
        broadcastRoom(roomCode, { type:'ended', roomCode });
      }
      return;
    }

    // NEXT (房主手动，可保留；自动推进由 answer 触发)
    if (t === 'next') {
      if (!roomCode) return;
      const room = wordClassRooms[roomCode];
      if (!room || !room.started) return;
      if (room.owner && room.owner !== username) return;
      const nextIdx = (room.state.currentIndex || 0) + 1;
      if (nextIdx < room.sequence.length) {
        room.state.currentIndex = nextIdx;
        // reset perIndexAnswered for new index (safety)
        room.state.perIndexAnswered[nextIdx] = new Set();
        broadcastRoom(roomCode, { type:'next_word', roomCode, index: nextIdx, word: room.sequence[nextIdx] });
      } else {
        const ranking = computeRanking(room);
        broadcastRoom(roomCode, { type:'ranking', roomCode, ranking });
        broadcastRoom(roomCode, { type:'ended', roomCode });
        room.started = false;
      }
      return;
    }

    // ANSWER
    if (t === 'answer') {
      if (!roomCode || !username) return;
      const room = wordClassRooms[roomCode];
      if (!room || !room.started) return;
      
      // 如果是观众的作答，直接忽略
      const memberInfo = room.members[username];
      if (memberInfo && memberInfo.isViewer) {
        console.log(`[ANSWER] Ignored viewer answer from ${username}`);
        return;
      }
      
      // 如果是管理员的作答，直接忽略
      if (isAdminAccount(username)) {
        console.log(`[ANSWER] 管理员 ${username} 的答题被忽略`);
        return;
      }
      
      // 统一使用服务器的 currentIndex 作为唯一真相来源
      const idx = room.state.currentIndex || 0;
      const correct = !!data.correct;
      const timeTaken = Number(data.timeTaken) || 0;

      room.state.answered = room.state.answered || {};
      room.state.perIndexAnswered = room.state.perIndexAnswered || {};

      if (!room.state.answered[username]) room.state.answered[username] = { correctCount: 0, answersCount: 0, totalTime: 0 };
      const st = room.state.answered[username];
      st.answersCount = (st.answersCount || 0) + 1;
      st.totalTime = (st.totalTime || 0) + timeTaken;
      if (correct) st.correctCount = (st.correctCount || 0) + 1;

      // mark per-index answered set
      if (!room.state.perIndexAnswered[idx]) room.state.perIndexAnswered[idx] = new Set();
      room.state.perIndexAnswered[idx].add(username);

      // broadcast this answer event & updated ranking
      const ranking = computeRanking(room);
      broadcastRoom(roomCode, { type:'answer_update', roomCode, username, correct, timeTaken, index: idx });
      broadcastRoom(roomCode, { type:'ranking', roomCode, ranking });

      // 自动推进检查时只统计非观众、非管理员成员
      const onlineMembers = Object.entries(room.members || {})
        .filter(([_, m]) => !m.isViewer)
        .filter(([uname]) => !isAdminAccount(uname))
        .map(([uname]) => uname);
      const answeredSet = room.state.perIndexAnswered[idx] || new Set();
      // check every member in members list is in answeredSet
      const allAnswered = onlineMembers.length > 0 && onlineMembers.every(m => answeredSet.has(m));
      
      console.log(`[ANSWER] Room ${roomCode} Index ${idx}: ${username} answered. Answered: ${answeredSet.size}/${onlineMembers.length} (excluding viewers). AllAnswered: ${allAnswered}`);
      
      if (allAnswered) {
        // prevent duplicate timers
        if (room.state.autoNextTimer) {
          clearTimeout(room.state.autoNextTimer);
          room.state.autoNextTimer = null;
        }
        room.state.autoNextTimer = setTimeout(() => {
          // advance to next index
          const nextIdx = (room.state.currentIndex || 0) + 1;
          
          console.log(`[AUTO_NEXT] Room ${roomCode}: Current ${room.state.currentIndex}, Next ${nextIdx}, Total ${room.sequence.length}`);
          
          if (nextIdx < room.sequence.length) {
            room.state.currentIndex = nextIdx;
            // init perIndexAnswered for next index
            room.state.perIndexAnswered[nextIdx] = new Set();
            broadcastRoom(roomCode, { type:'next_word', roomCode, index: nextIdx, word: room.sequence[nextIdx] });
          } else {
            // finish
            console.log(`[TRAINING_END] Room ${roomCode}: All ${room.sequence.length} words completed`);
            const finalRanking = computeRanking(room);
            broadcastRoom(roomCode, { type:'ranking', roomCode, ranking: finalRanking });
            broadcastRoom(roomCode, { type:'ended', roomCode });
            room.started = false;
          }
          room.state.autoNextTimer = null;
        }, 1000);
      }
      return;
    }

    // SET_MODE (新增)
    if (t === 'set_mode') {
      if (!roomCode || !username) return safeSend(ws, { type:'error', message:'缺少 roomCode 或 username' });
      const room = wordClassRooms[roomCode];
      if (!room) return safeSend(ws, { type:'error', message:'房间不存在' });
      if (room.owner && room.owner !== username) return safeSend(ws, { type:'error', message:'只有房主可以切换训练模式' });
      
      const newMode = data.mode || 'eng-chn';
      if (!['eng-chn', 'listen-chn', 'chn-eng'].includes(newMode)) {
        return safeSend(ws, { type:'error', message:'无效的训练模式' });
      }
      
      room.mode = newMode;
      console.log(`[SET_MODE] Room ${roomCode}: Mode changed to ${newMode} by ${username}`);
      broadcastRoom(roomCode, { type:'mode_updated', roomCode, mode: newMode });
      return;
    }

    // RANKING（新增：转发排名更新）
    if (t === 'ranking') {
      if (!roomCode) return;
      const room = wordClassRooms[roomCode];
      if (!room) return;
      
      console.log(`[RANKING] 收到排名更新 from=${username} room=${roomCode}`);
      
      // 转发排名更新到同房间的所有客户端
      broadcastRoom(roomCode, {
        type: 'ranking',
        roomCode: roomCode,
        ranking: data.ranking,
        members: data.members,
        owner: data.owner
      });
      return;
    }

    // ROOM_UPDATE（新增：转发房间更新）
    if (t === 'room_update') {
      if (!roomCode) return;
      const room = wordClassRooms[roomCode];
      if (!room) return;
      
      console.log(`[ROOM_UPDATE] 收到房间更新 from=${username} room=${roomCode}`);
      
      // 转发房间更新到同房间的所有客户端
      broadcastRoom(roomCode, {
        type: 'room_update',
        roomCode: roomCode,
        owner: data.owner,
        members: data.members,
        ranking: data.ranking
      });
      return;
    }

    // PING
    if (t === 'ping') {
      safeSend(ws, { type:'pong' });
      return;
    }
  });

  ws.on('close', () => {
    // remove member from room(s)
    Object.keys(wordClassRooms).forEach(code => {
      const room = wordClassRooms[code];
      if (!room) return;
      
      // 同时检查 members 和 admins
      let found = Object.entries(room.members).find(([uname, obj]) => obj.ws === ws);
      let isFromAdmins = false;
      
      if (!found && room.admins) {
        found = Object.entries(room.admins).find(([uname, obj]) => obj.ws === ws);
        isFromAdmins = true;
      }
      
      if (found) {
        const [uname] = found;
        const isAdmin = isAdminAccount(uname);
        
        // 从相应的列表中删除
        if (isFromAdmins) {
          delete room.admins[uname];
        } else {
          delete room.members[uname];
        }
        
        // 清理该玩家的统计数据
        if (room.state && room.state.answered) {
          delete room.state.answered[uname];
        }
        // also remove from perIndexAnswered if present
        if (room.state && room.state.perIndexAnswered) {
          Object.values(room.state.perIndexAnswered).forEach(s => s.delete && s.delete(uname));
        }
        
        // 如果离开的是房主，重新分配房主（但管理员离开不影响房主）
        if (room.owner === uname && !isAdmin) {
          const nonViewerNonAdminMembers = Object.entries(room.members)
            .filter(([_, m]) => !m.isViewer)
            .filter(([u]) => !isAdminAccount(u))
            .map(([u]) => u);
          room.owner = nonViewerNonAdminMembers.length ? nonViewerNonAdminMembers[0] : null;
          console.log(`[房间 ${code}] 连接关闭，房主离开，新房主: ${room.owner || '无'}`);
        }
        
        // 广播时过滤掉观众和管理员
        const activeMembers = getRoomActiveMembers(room);
        
        broadcastRoom(code, { type:'room_update', roomCode: code, members: activeMembers, owner: room.owner, batch: room.batch, mode: room.mode || 'eng-chn', started: room.started });
        // 清理统计数据后，如果训练进行中则重新广播排行榜
        if (room.started && room.state && room.state.answered) {
          const ranking = computeRanking(room);
          broadcastRoom(code, { type:'ranking', roomCode: code, ranking });
        }
      }
      // optional cleanup: remove empty non-started room
      if (Object.keys(room.members).length === 0 && !room.started) {
        delete wordClassRooms[code];
      }
    });
  });
});

// periodic ping to keep connections alive and detect dead peers
setInterval(() => {
  wss.clients.forEach(function each(ws) {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

// HTTP API: get room state
app.get('/api/wordclass/room-state', (req, res) => {
  const roomCode = String((req.query.roomCode || '')).trim().toLowerCase();
  if (!roomCode) return res.status(400).json({ error: '缺少 roomCode' });
  const room = wordClassRooms[roomCode];
  if (!room) return res.json({ exists: false });
  res.json({
    exists: true,
    owner: room.owner,
    members: getRoomActiveMembers(room),
    batch: room.batch,
    mode: room.mode || 'eng-chn',
    started: room.started,
    sequenceLen: room.sequence.length || 0,
    ranking: computeRanking(room)
  });
});

// 修改 HTTP API join，返回 mode：

app.post('/api/wordclass/join', (req, res) => {
  const { username, roomCode } = req.body || {};
  if (!username || !roomCode) return res.status(400).json({ error: '缺少 username 或 roomCode' });
  const code = String(roomCode).trim().toLowerCase();
  createRoomIfNotExists(code);
  const room = wordClassRooms[code];
  if (!room.owner) room.owner = username;
  // mark member without ws (for REST-only clients)
  room.members[username] = { ws: null, joinedAt: new Date().toISOString() };
  res.json({ success: true, owner: room.owner, members: getRoomActiveMembers(room), batch: room.batch, mode: room.mode || 'eng-chn' });
});

// 修改 HTTP API set-batch，广播中包含 mode：

app.post('/api/wordclass/set-batch', (req, res) => {
  const { username, roomCode, batch } = req.body || {};
  if (!roomCode || !batch || !Array.isArray(batch.words)) return res.status(400).json({ error: '参数缺失或格式错误' });
  const code = String(roomCode).trim().toLowerCase();
  createRoomIfNotExists(code);
  const room = wordClassRooms[code];
  room.batch = { name: batch.name || (batch.words[0] || ''), words: batch.words.slice() };
  room.started = false;
  room.sequence = [];
  room.state = { currentIndex: 0, answered: {} };
  broadcastRoom(code, { type:'batch_updated', roomCode: code, batch: room.batch, mode: room.mode || 'eng-chn' });
  res.json({ success: true, batch: room.batch, mode: room.mode || 'eng-chn' });
});

// 修改 HTTP API leave，广播中包含 mode：

app.post('/api/wordclass/leave', (req, res) => {
  const { username, roomCode } = req.body || {};
  if (!username || !roomCode) return res.status(400).json({ error: '缺少 username 或 roomCode' });
  const code = String(roomCode).trim().toLowerCase();
  const room = wordClassRooms[code];
  if (!room) return res.json({ success: true }); // nothing to do
  delete room.members[username];
  if (room.owner === username) {
    const keys = Object.keys(room.members);
    room.owner = keys.length ? keys[0] : null;
  }
  broadcastRoom(code, { type:'room_update', roomCode: code, members: getRoomActiveMembers(room), owner: room.owner, batch: room.batch, mode: room.mode || 'eng-chn', started: room.started });
  res.json({ success: true });
});

// 使用 server.listen 启动 (替代原先的 app.listen)
server.listen(process.env.PORT || PORT, () => {
  console.log(`Server + WebSocket running at http://localhost:${process.env.PORT || PORT}/ (ws path: /ws)`);
  // 将原来放在早期 app.listen 回调中的初始化动作迁移到这里，确保只在单个监听点执行
  if (typeof initOralListeningTable === 'function') {
      try { initOralListeningTable(); } catch(e) { console.error('initOralListeningTable error', e); }
  }
  if (typeof scheduleOralListeningWeeklyClear === 'function') {
      try { scheduleOralListeningWeeklyClear(); } catch(e) { console.error('scheduleOralListeningWeeklyClear error', e); }
  }
});
// --- WebSocket 房间与多人训练后端逻辑结束 ---

// --- 课堂激励活动开始 ---
// --- 课堂选人游戏数据存储功能开始 ---
// 新建 choose_game_class 表和 choose_game_student 表
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS choose_game_classes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_username TEXT NOT NULL,
        source_class_id TEXT NOT NULL,
        name TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(owner_username, source_class_id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS choose_game_students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL,
        source_student_id TEXT NOT NULL,
        name TEXT NOT NULL,
        candies_json TEXT NOT NULL DEFAULT '[]',
        avatar_appearance_json TEXT,
        absent INTEGER NOT NULL DEFAULT 0,
        linked_username TEXT DEFAULT NULL,
        linked_type TEXT DEFAULT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(class_id) REFERENCES choose_game_classes(id),
        UNIQUE(class_id, source_student_id)
    )`);
});


function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) {
                reject(err);
                return;
            }
            resolve(this);
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(row || null);
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(rows || []);
        });
    });
}

function createHttpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function buildRegisteredExpireDate(grantTime) {
    if (!grantTime) return null;
    const grant = new Date(grantTime);
    if (Number.isNaN(grant.getTime())) return null;
    const expire = new Date(grant);
    expire.setMonth(grant.getMonth() + 1);
    return expire.toISOString();
}

async function getPermanentStudentByUsername(username) {
    return dbGet(
        `SELECT username, password, isTeacher, isLoggedIn, lastLoginDeviceId, grade_stu FROM students WHERE username = ?`,
        [username]
    );
}

async function getRegisteredStudentByUsername(username) {
    return dbGet(
        `SELECT username, password, status, grantTime, isTeacher, grade_stu FROM registered_stu WHERE username = ?`,
        [username]
    );
}

async function findChooseTeacherAccount(username, source = null) {
    if (source === 'permanent') {
        const permanentUser = await getPermanentStudentByUsername(username);
        return permanentUser ? { source: 'permanent', user: permanentUser } : null;
    }
    if (source === 'registered') {
        const registeredUser = await getRegisteredStudentByUsername(username);
        return registeredUser ? { source: 'registered', user: registeredUser } : null;
    }

    const permanentUser = await getPermanentStudentByUsername(username);
    if (permanentUser) {
        return { source: 'permanent', user: permanentUser };
    }

    const registeredUser = await getRegisteredStudentByUsername(username);
    return registeredUser ? { source: 'registered', user: registeredUser } : null;
}

function buildChooseTeacherPayload(account, deviceId = null) {
    const basePayload = {
        username: account.user.username,
        source: account.source,
        isTeacher: true,
        grade_stu: account.user.grade_stu || ''
    };

    if (account.source === 'permanent') {
        return {
            ...basePayload,
            deviceId,
            regStatus: null,
            regGrantTime: null,
            regExpireDate: null
        };
    }

    return {
        ...basePayload,
        deviceId: null,
        regStatus: account.user.status,
        regGrantTime: account.user.grantTime || null,
        regExpireDate: buildRegisteredExpireDate(account.user.grantTime)
    };
}

async function validateChooseTeacherSession({ username, source = null, deviceId = null }) {
    const account = await findChooseTeacherAccount(username, source);
    if (!account) {
        throw createHttpError(404, '用户不存在');
    }
    if (!account.user.isTeacher) {
        throw createHttpError(403, '只有老师账号可以进入此页面');
    }

    if (account.source === 'permanent') {
        if (!deviceId) {
            throw createHttpError(400, '缺少设备标识');
        }
        if (!account.user.isLoggedIn || !account.user.lastLoginDeviceId) {
            throw createHttpError(401, '当前老师账号未登录');
        }
        if (account.user.lastLoginDeviceId !== deviceId) {
            throw createHttpError(403, '当前老师账号已在其他设备登录');
        }
    }

    return account;
}

function normalizeChooseReplacePayload(classData, studentData) {
    const classId = String(classData && classData.id ? classData.id : '').trim();
    const className = String(classData && classData.name ? classData.name : '').trim();
    const studentId = String(studentData && studentData.id ? studentData.id : '').trim();
    const studentName = String(studentData && studentData.name ? studentData.name : '').trim();

    if (!classId || !className || !studentId || !studentName) {
        throw createHttpError(400, '班级或学生数据不完整');
    }

    return {
        sourceClassId: classId,
        className,
        sourceStudentId: studentId,
        studentName,
        candiesJson: JSON.stringify(Array.isArray(studentData && studentData.candies) ? studentData.candies : []),
        avatarAppearanceJson: JSON.stringify(studentData && studentData.avatarAppearance ? studentData.avatarAppearance : null),
        absent: studentData && studentData.absent ? 1 : 0
    };
}

async function upsertChooseLinkedStudentState(ownerUsername, classData, studentData, options = {}) {
    const normalized = normalizeChooseReplacePayload(classData, studentData);
    const linkedStudent = studentData && studentData.linkedStudent ? studentData.linkedStudent : options.linkedStudent;
    const linkedUsername = String(linkedStudent && linkedStudent.username ? linkedStudent.username : '').trim();
    const linkedType = String(linkedStudent && linkedStudent.type ? linkedStudent.type : '').trim();
    const studentName = String(options.studentName || normalized.studentName || '').trim();
    const now = options.now || new Date().toISOString();

    if (!linkedUsername || !['permanent', 'registered'].includes(linkedType)) {
        throw createHttpError(400, '未找到已联网学生信息');
    }

    const existingClass = await dbGet(
        `SELECT id FROM choose_game_classes WHERE owner_username = ? AND source_class_id = ?`,
        [ownerUsername, normalized.sourceClassId]
    );

    let classId = null;
    if (existingClass) {
        classId = existingClass.id;
        await dbRun(
            `UPDATE choose_game_classes SET name = ?, updatedAt = ? WHERE id = ?`,
            [normalized.className, now, classId]
        );
    } else {
        const classInsert = await dbRun(
            `INSERT INTO choose_game_classes (owner_username, source_class_id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`,
            [ownerUsername, normalized.sourceClassId, normalized.className, now, now]
        );
        classId = classInsert.lastID;
    }

    const existingStudent = await dbGet(
        `SELECT id FROM choose_game_students WHERE class_id = ? AND source_student_id = ?`,
        [classId, normalized.sourceStudentId]
    );

    if (existingStudent) {
        await dbRun(
            `UPDATE choose_game_students
             SET name = ?, candies_json = ?, avatar_appearance_json = ?, linked_username = ?, linked_type = ?, updatedAt = ?
             WHERE id = ?`,
            [
                studentName,
                normalized.candiesJson,
                normalized.avatarAppearanceJson,
                linkedUsername,
                linkedType,
                now,
                existingStudent.id
            ]
        );
    } else {
        await dbRun(
            `INSERT INTO choose_game_students (
                class_id, source_student_id, name, candies_json, avatar_appearance_json, absent,
                linked_username, linked_type, createdAt, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                classId,
                normalized.sourceStudentId,
                studentName,
                normalized.candiesJson,
                normalized.avatarAppearanceJson,
                normalized.absent,
                linkedUsername,
                linkedType,
                now,
                now
            ]
        );
    }
}


app.post('/api/choose/teacher-login', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '').trim();
    const deviceId = String(req.body.deviceId || '').trim() || null;

    if (!username || !password) {
        return res.status(400).json({ error: '请输入用户名和密码' });
    }

    try {
        const permanentUser = await getPermanentStudentByUsername(username);
        if (permanentUser) {
            if (!deviceId) {
                throw createHttpError(400, '缺少设备标识');
            }
            if (permanentUser.password !== password) {
                throw createHttpError(401, '密码错误');
            }
            if (!permanentUser.isTeacher) {
                throw createHttpError(403, '只有老师账号可以进入此页面');
            }

            const now = new Date().toISOString();
            await dbRun(
                `UPDATE students SET isLoggedIn = 1, lastLoginDeviceId = ?, lastLogin = ? WHERE username = ?`,
                [deviceId, now, username]
            );

            return res.json({
                success: true,
                user: buildChooseTeacherPayload({
                    source: 'permanent',
                    user: { ...permanentUser, username, isLoggedIn: 1, lastLoginDeviceId: deviceId }
                }, deviceId)
            });
        }

        const registeredUser = await getRegisteredStudentByUsername(username);
        if (!registeredUser) {
            throw createHttpError(404, '用户不存在');
        }
        if (registeredUser.password !== password) {
            throw createHttpError(401, '密码错误');
        }
        if (!registeredUser.isTeacher) {
            throw createHttpError(403, '只有老师账号可以进入此页面');
        }

        await dbRun(`UPDATE registered_stu SET lastLogin = ? WHERE username = ?`, [new Date().toISOString(), username]);

        return res.json({
            success: true,
            user: buildChooseTeacherPayload({
                source: 'registered',
                user: { ...registeredUser, username }
            })
        });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.message || '老师登录失败' });
    }
});

app.post('/api/choose/teacher-validate', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const source = typeof req.body.source === 'string' ? req.body.source.trim() || null : null;
    const deviceId = String(req.body.deviceId || '').trim() || null;

    if (!username) {
        return res.status(400).json({ error: '缺少用户名' });
    }

    try {
        const account = await validateChooseTeacherSession({ username, source, deviceId });
        return res.json({
            success: true,
            user: buildChooseTeacherPayload(account, account.source === 'permanent' ? deviceId : null)
        });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.message || '老师登录状态校验失败' });
    }
});

app.post('/api/choose/student-candidates', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const source = typeof req.body.source === 'string' ? req.body.source.trim() || null : null;
    const deviceId = String(req.body.deviceId || '').trim() || null;
    const keyword = String(req.body.keyword || '').trim();

    if (!username) {
        return res.status(400).json({ error: '缺少用户名' });
    }

    try {
        await validateChooseTeacherSession({ username, source, deviceId });
        const likeKeyword = `%${keyword.replace(/[%_]/g, '\\$&')}%`;
        const rows = await dbAll(
            `
            SELECT username, 'permanent' AS type, grade_stu, NULL AS status
            FROM students
            WHERE COALESCE(isTeacher, 0) = 0 AND username LIKE ? ESCAPE '\\'
            UNION ALL
            SELECT username, 'registered' AS type, grade_stu, status
            FROM registered_stu
            WHERE COALESCE(isTeacher, 0) = 0 AND username LIKE ? ESCAPE '\\'
            ORDER BY username COLLATE NOCASE ASC
            LIMIT 80
            `,
            [likeKeyword, likeKeyword]
        );

        return res.json({
            success: true,
            candidates: rows.map(row => ({
                username: row.username,
                type: row.type,
                grade_stu: row.grade_stu || '',
                status: row.status
            }))
        });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.message || '获取学生名单失败' });
    }
});

app.post('/api/choose/replace-student', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const source = typeof req.body.source === 'string' ? req.body.source.trim() || null : null;
    const deviceId = String(req.body.deviceId || '').trim() || null;
    const classData = req.body.classData || null;
    const studentData = req.body.studentData || null;
    const replacement = req.body.replacement || null;

    if (!username || !classData || !studentData || !replacement) {
        return res.status(400).json({ error: '缺少替换所需数据' });
    }

    try {
        const account = await validateChooseTeacherSession({ username, source, deviceId });
        const normalized = normalizeChooseReplacePayload(classData, studentData);
        const replacementUsername = String(replacement.username || '').trim();
        const replacementType = String(replacement.type || '').trim();

        if (!replacementUsername || !['permanent', 'registered'].includes(replacementType)) {
            throw createHttpError(400, '替换目标无效');
        }

        const replacementUser = replacementType === 'permanent'
            ? await dbGet(`SELECT username, isTeacher FROM students WHERE username = ?`, [replacementUsername])
            : await dbGet(`SELECT username, isTeacher FROM registered_stu WHERE username = ?`, [replacementUsername]);

        if (!replacementUser || replacementUser.isTeacher) {
            throw createHttpError(404, '未找到可替换的学生账号');
        }

        const now = new Date().toISOString();
        let classId = null;

        await dbRun('BEGIN TRANSACTION');
        try {
            const existingClass = await dbGet(
                `SELECT id FROM choose_game_classes WHERE owner_username = ? AND source_class_id = ?`,
                [account.user.username, normalized.sourceClassId]
            );

            if (existingClass) {
                classId = existingClass.id;
                await dbRun(
                    `UPDATE choose_game_classes SET name = ?, updatedAt = ? WHERE id = ?`,
                    [normalized.className, now, classId]
                );
            } else {
                const classInsert = await dbRun(
                    `INSERT INTO choose_game_classes (owner_username, source_class_id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`,
                    [account.user.username, normalized.sourceClassId, normalized.className, now, now]
                );
                classId = classInsert.lastID;
            }

            const existingStudent = await dbGet(
                `SELECT id FROM choose_game_students WHERE class_id = ? AND source_student_id = ?`,
                [classId, normalized.sourceStudentId]
            );

            if (existingStudent) {
                await dbRun(
                    `UPDATE choose_game_students
                     SET name = ?, candies_json = ?, avatar_appearance_json = ?, absent = ?, linked_username = ?, linked_type = ?, updatedAt = ?
                     WHERE id = ?`,
                    [
                        replacementUsername,
                        normalized.candiesJson,
                        normalized.avatarAppearanceJson,
                        normalized.absent,
                        replacementUsername,
                        replacementType,
                        now,
                        existingStudent.id
                    ]
                );
            } else {
                await dbRun(
                    `INSERT INTO choose_game_students (
                        class_id, source_student_id, name, candies_json, avatar_appearance_json, absent,
                        linked_username, linked_type, createdAt, updatedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        classId,
                        normalized.sourceStudentId,
                        replacementUsername,
                        normalized.candiesJson,
                        normalized.avatarAppearanceJson,
                        normalized.absent,
                        replacementUsername,
                        replacementType,
                        now,
                        now
                    ]
                );
            }

            await dbRun('COMMIT');
        } catch (error) {
            await dbRun('ROLLBACK');
            throw error;
        }

        return res.json({
            success: true,
            studentName: replacementUsername,
            linkedStudent: {
                username: replacementUsername,
                type: replacementType
            }
        });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.message || '替换学生失败' });
    }
});

app.post('/api/choose/linked-students-state', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const source = typeof req.body.source === 'string' ? req.body.source.trim() || null : null;
    const deviceId = String(req.body.deviceId || '').trim() || null;
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!username) {
        return res.status(400).json({ error: '缺少老师账号' });
    }

    try {
        const account = await validateChooseTeacherSession({ username, source, deviceId });
        const requestedKeys = new Set(
            items
                .map(item => {
                    const classId = String(item && item.classId ? item.classId : '').trim();
                    const studentId = String(item && item.studentId ? item.studentId : '').trim();
                    return classId && studentId ? `${classId}::${studentId}` : '';
                })
                .filter(Boolean)
        );

        const rows = await dbAll(
            `
            SELECT
                cgc.source_class_id,
                cgs.source_student_id,
                cgs.name,
                cgs.candies_json,
                cgs.avatar_appearance_json,
                cgs.absent,
                cgs.linked_username,
                cgs.linked_type,
                sr.pet_food AS pet_food
            FROM choose_game_students cgs
            JOIN choose_game_classes cgc ON cgc.id = cgs.class_id
            LEFT JOIN student_rewards sr ON sr.username = cgs.linked_username AND sr.source = cgs.linked_type
            WHERE cgc.owner_username = ?
            `,
            [account.user.username]
        );

        const students = rows
            .filter(row => requestedKeys.size === 0 || requestedKeys.has(`${row.source_class_id}::${row.source_student_id}`))
            .map(row => {
                let candies = [];
                let avatarAppearance = null;

                try {
                    const parsedCandies = JSON.parse(row.candies_json || '[]');
                    candies = Array.isArray(parsedCandies) ? parsedCandies : [];
                } catch {
                    candies = [];
                }

                try {
                    avatarAppearance = row.avatar_appearance_json ? JSON.parse(row.avatar_appearance_json) : null;
                } catch {
                    avatarAppearance = null;
                }

                return {
                    classId: row.source_class_id,
                    studentId: row.source_student_id,
                    name: row.name || '',
                    candies,
                    avatarAppearance,
                    absent: Boolean(row.absent),
                    linkedStudent: row.linked_username && row.linked_type
                        ? { username: row.linked_username, type: row.linked_type }
                        : null,
                    pet_food: Number(row.pet_food || 0)
                };
            });

        return res.json({ success: true, students });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.message || '获取联网学生数据失败' });
    }
});

app.post('/api/choose/update-linked-students-state', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const source = typeof req.body.source === 'string' ? req.body.source.trim() || null : null;
    const deviceId = String(req.body.deviceId || '').trim() || null;
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!username || items.length === 0) {
        return res.status(400).json({ error: '缺少要同步的学生数据' });
    }

    try {
        const account = await validateChooseTeacherSession({ username, source, deviceId });
        const now = new Date().toISOString();

        await dbRun('BEGIN TRANSACTION');
        try {
            for (const item of items) {
                if (!item || !item.classData || !item.studentData) {
                    throw createHttpError(400, '同步数据格式不正确');
                }
                await upsertChooseLinkedStudentState(account.user.username, item.classData, item.studentData, { now });
            }
            await dbRun('COMMIT');
        } catch (error) {
            await dbRun('ROLLBACK');
            throw error;
        }

        return res.json({ success: true, updated: items.length });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.message || '同步联网学生数据失败' });
    }
});

app.get('/api/choose/manage-list', async (req, res) => {
    try {
        const permanentUsers = await dbAll(
            `SELECT username FROM students ORDER BY rowid ASC, username COLLATE NOCASE ASC`
        );
        const permanentUserIdMap = new Map(
            permanentUsers.map((row, index) => [
                row.username,
                `TX${String(index + 1).padStart(3, '0')}`
            ])
        );

        const rows = await dbAll(
            `
            SELECT
                cgs.id,
                cgs.name,
                cgs.candies_json,
                cgs.avatar_appearance_json,
                cgs.absent,
                cgs.linked_username,
                cgs.linked_type,
                cgc.name AS class_name,
                rs.userId AS registered_user_id,
                rs.username AS registered_username,
                ps.username AS permanent_username
            FROM choose_game_students cgs
            JOIN choose_game_classes cgc ON cgc.id = cgs.class_id
            LEFT JOIN registered_stu rs
                ON cgs.linked_type = 'registered' AND rs.username = cgs.linked_username
            LEFT JOIN students ps
                ON cgs.linked_type = 'permanent' AND ps.username = cgs.linked_username
            ORDER BY cgc.name COLLATE NOCASE ASC, cgs.name COLLATE NOCASE ASC
            `
        );

        const students = rows.map(row => {
            let candies = [];
            let avatarAppearance = null;

            try {
                const parsedCandies = JSON.parse(row.candies_json || '[]');
                candies = Array.isArray(parsedCandies) ? parsedCandies : [];
            } catch {
                candies = [];
            }

            try {
                avatarAppearance = row.avatar_appearance_json ? JSON.parse(row.avatar_appearance_json) : null;
            } catch {
                avatarAppearance = null;
            }

            return {
                id: row.id,
                userId: row.linked_type === 'registered'
                    ? (row.registered_user_id || row.registered_username || row.linked_username || '')
                    : (permanentUserIdMap.get(row.permanent_username || row.linked_username || '') || ''),
                className: row.class_name || '',
                name: row.name || '',
                candyCount: candies.length,
                avatarAppearance,
                absent: Boolean(row.absent),
                linkedUsername: row.linked_username || '',
                linkedType: row.linked_type || ''
            };
        });

        return res.json({ success: true, students });
    } catch (error) {
        return res.status(500).json({ error: error.message || '获取选人游戏数据失败' });
    }
});

function parseChooseCandiesJson(candiesJson) {
    try {
        const parsed = JSON.parse(candiesJson || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function parseChooseAvatarAppearanceJson(avatarAppearanceJson) {
    try {
        return avatarAppearanceJson ? JSON.parse(avatarAppearanceJson) : null;
    } catch {
        return null;
    }
}

async function getPermanentDisplayUserId(username) {
    const rows = await dbAll(`SELECT username FROM students ORDER BY rowid ASC, username COLLATE NOCASE ASC`);
    const index = rows.findIndex(row => row.username === username);
    return index >= 0 ? `TX${String(index + 1).padStart(3, '0')}` : '';
}

async function validateGameselfAccount({ username, password, deviceId = null }) {
    const normalizedUsername = String(username || '').trim();
    const normalizedPassword = String(password || '').trim();
    const normalizedDeviceId = String(deviceId || '').trim() || null;

    if (!normalizedUsername || !normalizedPassword) {
        throw createHttpError(400, '缺少用户名或密码');
    }

    const permanentUser = await dbGet(
        `SELECT username, password, lastLoginDeviceId FROM students WHERE username = ?`,
        [normalizedUsername]
    );
    if (permanentUser) {
        if (permanentUser.password !== normalizedPassword) {
            throw createHttpError(401, '登录信息已失效，请重新登录');
        }
        if (normalizedDeviceId && permanentUser.lastLoginDeviceId && permanentUser.lastLoginDeviceId !== normalizedDeviceId) {
            throw createHttpError(403, '当前账号已在其他设备登录，请重新登录');
        }
        return {
            source: 'permanent',
            user: permanentUser,
            userId: await getPermanentDisplayUserId(normalizedUsername)
        };
    }

    const registeredUser = await dbGet(
        `SELECT username, password, userId FROM registered_stu WHERE username = ?`,
        [normalizedUsername]
    );
    if (!registeredUser) {
        throw createHttpError(404, '用户不存在');
    }
    if (registeredUser.password !== normalizedPassword) {
        throw createHttpError(401, '登录信息已失效，请重新登录');
    }

    return {
        source: 'registered',
        user: registeredUser,
        userId: registeredUser.userId || ''
    };
}

app.post('/api/gameself/choose-profile', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '').trim();
    const deviceId = String(req.body.deviceId || '').trim() || null;

    try {
        const account = await validateGameselfAccount({ username, password, deviceId });
        const rows = await dbAll(
            `
            SELECT name, candies_json, avatar_appearance_json, updatedAt
            FROM choose_game_students
            WHERE linked_username = ? AND linked_type = ?
            ORDER BY datetime(updatedAt) DESC, id DESC
            `,
            [username, account.source]
        );

        let candyCount = 0;
        let avatarAppearance = null;
        let displayName = username;

        rows.forEach((row, index) => {
            const candies = parseChooseCandiesJson(row.candies_json);
            candyCount += candies.length;
            if (index === 0 && row.name) {
                displayName = row.name;
            }
            if (!avatarAppearance) {
                avatarAppearance = parseChooseAvatarAppearanceJson(row.avatar_appearance_json);
            }
        });

        // 查询宠物主食数量
        let petFoodCount = 0;
        try {
            const reward = await dbGet(
                `SELECT pet_food FROM student_rewards WHERE username = ? AND source = ?`,
                [username, account.source]
            );
            if (reward) petFoodCount = reward.pet_food;
        } catch (_) { /* 表可能不存在，忽略 */ }

        return res.json({
            success: true,
            profile: {
                username,
                displayName,
                userId: account.userId,
                source: account.source,
                hasChooseData: rows.length > 0,
                candyCount,
                petFoodCount,
                avatarAppearance
            }
        });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.message || '获取个人互动数据失败' });
    }
});

app.post('/api/gameself/choose-avatar', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '').trim();
    const deviceId = String(req.body.deviceId || '').trim() || null;
    const avatarAppearance = req.body.avatarAppearance;
    const COST = 5;

    if (!avatarAppearance || typeof avatarAppearance !== 'object') {
        return res.status(400).json({ error: '缺少角色形象数据' });
    }

    try {
        const account = await validateGameselfAccount({ username, password, deviceId });
        const rows = await dbAll(
            `
            SELECT id, candies_json
            FROM choose_game_students
            WHERE linked_username = ? AND linked_type = ?
            ORDER BY datetime(updatedAt) DESC, id DESC
            `,
            [username, account.source]
        );

        if (rows.length === 0) {
            throw createHttpError(404, '当前账号还没有课堂互动数据');
        }

        const normalizedRows = rows.map(row => ({
            id: row.id,
            candies: parseChooseCandiesJson(row.candies_json)
        }));
        const totalCandies = normalizedRows.reduce((sum, row) => sum + row.candies.length, 0);

        if (totalCandies < COST) {
            throw createHttpError(400, `保存形象需要 ${COST} 个糖果，但当前只有 ${totalCandies} 个。`);
        }

        let remainingCost = COST;
        normalizedRows.forEach(row => {
            if (remainingCost <= 0) return;
            const removable = Math.min(remainingCost, row.candies.length);
            if (removable > 0) {
                row.candies = row.candies.slice(0, row.candies.length - removable);
                remainingCost -= removable;
            }
        });

        const now = new Date().toISOString();
        const avatarJson = JSON.stringify(avatarAppearance);

        await dbRun('BEGIN TRANSACTION');
        try {
            for (const row of normalizedRows) {
                await dbRun(
                    `UPDATE choose_game_students SET candies_json = ?, avatar_appearance_json = ?, updatedAt = ? WHERE id = ?`,
                    [JSON.stringify(row.candies), avatarJson, now, row.id]
                );
            }
            await dbRun('COMMIT');
        } catch (error) {
            await dbRun('ROLLBACK');
            throw error;
        }

        return res.json({
            success: true,
            candyCount: totalCandies - COST,
            avatarAppearance
        });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.message || '保存角色形象失败' });
    }
});
// --- 课堂选人游戏数据存储功能结束 ---

// =============================================================================
// --- 班级宠物园功能开始 ---
// =============================================================================

// 宠物类型注册表
const PET_GARDEN_TYPES = [
    { id: 'llama', name: '羊驼', folder: 'llama' },
    { id: 'call_duck', name: '柯尔鸭', folder: 'call_duck' },
    { id: 'border_collie', name: '边牧', folder: 'border_collie' },
    { id: 'westie', name: '西高地犬', folder: 'westie' },
    { id: 'budgie', name: '虎皮鹦鹉', folder: 'budgie' },
    { id: 'silver_shorthair', name: '银渐层', folder: 'silver_shorthair' },
    { id: 'schnauzer', name: '雪纳瑞', folder: 'schnauzer' },
    { id: 'panda', name: '熊猫', folder: 'panda' },
    { id: 'piglet', name: '小猪猪', folder: 'piglet' },
    { id: 'lamb', name: '小羊仔', folder: 'lamb' },
    { id: 'rabbit', name: '小白兔', folder: 'rabbit' },
    { id: 'chick', name: '小鸡仔', folder: 'chick' },
    { id: 'teddy', name: '泰迪', folder: 'teddy' },
    { id: 'calico', name: '三花猫', folder: 'calico' },
    { id: 'foal', name: '小马驹', folder: 'foal' },
    { id: 'tiger', name: '老虎', folder: 'tiger' },
    { id: 'blue_cat', name: '蓝猫', folder: 'blue_cat' },
    { id: 'labrador', name: '拉布拉多', folder: 'labrador' },
    { id: 'corgi', name: '柯基', folder: 'corgi' },
    { id: 'capybara', name: '卡皮巴拉', folder: 'capybara' },
    { id: 'nine_tail_fox', name: '九尾狐', folder: 'nine_tail_fox' },
    { id: 'golden_shorthair', name: '金渐层', folder: 'golden_shorthair' },
    { id: 'tabby', name: '虎斑猫', folder: 'tabby' },
    { id: 'monkey', name: '猴子', folder: 'monkey' },
    { id: 'black_cat', name: '小黑猫', folder: 'black_cat' },
    { id: 'french_bulldog', name: '法斗', folder: 'french_bulldog' },
    { id: 'white_bear', name: '大白熊', folder: 'white_bear' },
    { id: 'bichon', name: '比熊', folder: 'bichon' },
    { id: 'leopard', name: '小花豹', folder: 'leopard' },
    { id: 'white_tiger', name: '白虎', folder: 'white_tiger' },
    { id: 'vermilion_bird', name: '朱雀', folder: 'vermilion_bird' },
    { id: 'unicorn', name: '独角兽', folder: 'unicorn' },
    { id: 'succulent_sprite', name: '多肉精灵', folder: 'succulent_sprite' },
    { id: 'suanni', name: '狻猊', folder: 'suanni' },
    { id: 'shiba', name: '柴犬', folder: 'shiba' },
    { id: 'samoyed', name: '萨摩耶', folder: 'samoyed' },
    { id: 'red_panda', name: '小熊猫', folder: 'red_panda' },
    { id: 'ragdoll', name: '布偶猫', folder: 'ragdoll' },
    { id: 'pixiu', name: '貔貅', folder: 'pixiu' },
    { id: 'orange_cat', name: '橘猫', folder: 'orange_cat' },
    { id: 'husky', name: '哈士奇', folder: 'husky' },
    { id: 'golden_retriever', name: '金毛', folder: 'golden_retriever' },
    { id: 'garfield_cat', name: '加菲猫', folder: 'garfield_cat' },
    { id: 'lop_rabbit', name: '垂耳兔', folder: 'lop_rabbit' },
    { id: 'azure_dragon', name: '青龙', folder: 'azure_dragon' },
    { id: 'angora_rabbit', name: '安哥拉兔', folder: 'angora_rabbit' }
];

// 宠物等级成长值上限计算: 每级需要 level * 40 的成长值
function getPetMaxGrowth(level) {
    return Math.max(Number(level) || 0, 1) * 40;
}

function applyPetGrowthDelta(level, growthValue, delta) {
    let nextLevel = Math.max(Number(level) || 0, 0);
    let nextGrowth = Math.max(Number(growthValue) || 0, 0) + delta;
    let maxGrowth = getPetMaxGrowth(nextLevel);

    while (nextGrowth >= maxGrowth) {
        nextGrowth -= maxGrowth;
        nextLevel += 1;
        maxGrowth = getPetMaxGrowth(nextLevel);
    }

    while (nextGrowth < 0 && nextLevel > 0) {
        nextLevel -= 1;
        nextGrowth += getPetMaxGrowth(nextLevel);
        maxGrowth = getPetMaxGrowth(nextLevel);
    }

    if (nextGrowth < 0) {
        nextGrowth = 0;
    }

    return {
        level: nextLevel,
        growth_value: roundPetStat(nextGrowth),
        max_growth_value: getPetMaxGrowth(nextLevel)
    };
}

function applyPetSatietyDelta(satiety, delta) {
    const currentSatiety = Number(satiety) || 0;
    return Math.max(0, Math.min(currentSatiety + delta, 100));
}

function getPetSatietyDecayStage(satiety) {
    const value = Math.max(Number(satiety) || 0, 0);
    if (value > 70) return { rate: 1.25, lowerBound: 70 };
    if (value > 55) return { rate: 0.625, lowerBound: 55 };
    if (value > 19) return { rate: 0.5, lowerBound: 19 };
    if (value > 0) return { rate: 1, lowerBound: 0 };
    return { rate: 0, lowerBound: 0 };
}

function getPetGrowthRateBySatiety(satiety) {
    const value = Math.max(Number(satiety) || 0, 0);
    if (value > 70) return 1;
    if (value > 55) return 0;
    if (value > 19) return -1;
    if (value > 0) return -2;
    return 0;
}

function roundPetStat(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function applyTimedPetSatietyDecay(satiety, elapsedHours) {
    let nextSatiety = Math.max(Number(satiety) || 0, 0);
    let remainingHours = Math.max(Number(elapsedHours) || 0, 0);

    while (remainingHours > 1e-9 && nextSatiety > 0) {
        const stage = getPetSatietyDecayStage(nextSatiety);
        if (!stage.rate) break;
        const distanceToLower = Math.max(nextSatiety - stage.lowerBound, 0);
        const hoursToLower = distanceToLower / stage.rate;
        if (remainingHours < hoursToLower - 1e-9) {
            nextSatiety -= remainingHours * stage.rate;
            remainingHours = 0;
            break;
        }
        nextSatiety = stage.lowerBound;
        remainingHours -= hoursToLower;
    }

    return roundPetStat(Math.max(nextSatiety, 0));
}

function applyTimedPetAutoChanges(level, growthValue, satiety, elapsedHours) {
    let nextSatiety = Math.max(Number(satiety) || 0, 0);
    let remainingHours = Math.max(Number(elapsedHours) || 0, 0);
    let totalGrowthDelta = 0;

    while (remainingHours > 1e-9 && nextSatiety > 0) {
        const satietyStage = getPetSatietyDecayStage(nextSatiety);
        if (!satietyStage.rate) break;
        const growthRate = getPetGrowthRateBySatiety(nextSatiety);
        const distanceToLower = Math.max(nextSatiety - satietyStage.lowerBound, 0);
        const hoursToLower = distanceToLower / satietyStage.rate;
        const appliedHours = remainingHours < hoursToLower - 1e-9 ? remainingHours : hoursToLower;

        nextSatiety -= appliedHours * satietyStage.rate;
        totalGrowthDelta += appliedHours * growthRate;
        remainingHours -= appliedHours;

        if (remainingHours >= 0 && Math.abs(nextSatiety - satietyStage.lowerBound) < 1e-7) {
            nextSatiety = satietyStage.lowerBound;
        }
    }

    const growthState = applyPetGrowthDelta(level, growthValue, roundPetStat(totalGrowthDelta));
    return {
        satiety: roundPetStat(Math.max(nextSatiety, 0)),
        growth_value: growthState.growth_value,
        level: growthState.level,
        max_growth_value: growthState.max_growth_value,
        growth_delta: roundPetStat(totalGrowthDelta)
    };
}

// 获取宠物图片路径:
// - 刚领养时显示 games/petgarden/petegg.png，等级为 0
// - 1 级显示 pets/{folder}/{folder}01.png
// - 2 级显示 pets/{folder}/{folder}02.png，以此类推
function getPetImagePath(petType, level) {
    if (!petType || (Number(level) || 0) <= 0) return 'games/petgarden/petegg.png';
    const typeInfo = PET_GARDEN_TYPES.find(t => t.id === petType);
    if (!typeInfo) return 'games/petgarden/petegg.png';
    const lvStr = String(level).padStart(2, '0');
    return `games/petgarden/pets/${typeInfo.folder}/${typeInfo.folder}${lvStr}.png`;
}

// --- 班级宠物园数据库表 ---
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS pet_garden_classes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_username TEXT NOT NULL,
        name TEXT NOT NULL,
        lock_password TEXT DEFAULT NULL,
        security_code TEXT DEFAULT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pet_garden_students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        student_number TEXT DEFAULT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        linked_username TEXT DEFAULT NULL,
        linked_type TEXT DEFAULT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(class_id) REFERENCES pet_garden_classes(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pet_garden_pets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL UNIQUE,
        pet_type TEXT DEFAULT NULL,
        pet_name TEXT DEFAULT NULL,
        level INTEGER NOT NULL DEFAULT 0,
        growth_value INTEGER NOT NULL DEFAULT 0,
        satiety INTEGER NOT NULL DEFAULT 100,
        satiety_updated_at TEXT DEFAULT NULL,
        adopted_at TEXT DEFAULT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(student_id) REFERENCES pet_garden_students(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pet_garden_pet_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        pet_type TEXT DEFAULT NULL,
        pet_name TEXT DEFAULT NULL,
        level INTEGER NOT NULL DEFAULT 0,
        growth_value INTEGER NOT NULL DEFAULT 0,
        satiety INTEGER NOT NULL DEFAULT 100,
        satiety_updated_at TEXT DEFAULT NULL,
        adopted_at TEXT DEFAULT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(student_id) REFERENCES pet_garden_students(id)
    )`);

    db.run(`ALTER TABLE pet_garden_students ADD COLUMN current_pet_id INTEGER DEFAULT NULL`, () => {});
    db.run(`ALTER TABLE pet_garden_pets ADD COLUMN satiety_updated_at TEXT`, () => {});
    db.run(`ALTER TABLE pet_garden_pet_records ADD COLUMN satiety_updated_at TEXT`, () => {});
    db.run(`UPDATE pet_garden_pets SET satiety_updated_at = COALESCE(satiety_updated_at, adopted_at, updatedAt, createdAt)`, () => {});
    db.run(`UPDATE pet_garden_pet_records SET satiety_updated_at = COALESCE(satiety_updated_at, adopted_at, updatedAt, createdAt)`, () => {});
});

function buildPetGardenPetPayload(row) {
    if (!row) return null;
    const typeInfo = row.pet_type ? PET_GARDEN_TYPES.find(t => t.id === row.pet_type) : null;
    return {
        ...row,
        growth_value: roundPetStat(row.growth_value),
        satiety: roundPetStat(row.satiety),
        pet_type_name: typeInfo ? typeInfo.name : '',
        max_growth_value: getPetMaxGrowth(row.level),
        pet_image: getPetImagePath(row.pet_type, row.level)
    };
}

function canAddExtraPet(pets) {
    return Array.isArray(pets) && pets.length > 0 && pets.every(pet => Number(pet.level || 0) >= 5);
}

async function listStudentPetRecords(studentId) {
    const rows = await dbAll(
        `SELECT id, student_id, pet_type, pet_name, level, growth_value, satiety, satiety_updated_at, adopted_at, createdAt, updatedAt
         FROM pet_garden_pet_records
         WHERE student_id = ?
         ORDER BY id ASC`,
        [studentId]
    );
    return rows;
}

async function createPetGardenEggRecord(studentId, nowIso = new Date().toISOString()) {
    const student = await dbGet(`SELECT id FROM pet_garden_students WHERE id = ?`, [studentId]);
    if (!student) return null;
    const result = await dbRun(
        `INSERT INTO pet_garden_pet_records (student_id, level, growth_value, satiety, satiety_updated_at, createdAt, updatedAt)
         VALUES (?, 0, 0, 100, ?, ?, ?)`,
        [studentId, nowIso, nowIso, nowIso]
    );
    await dbRun(
        `UPDATE pet_garden_students SET current_pet_id = ?, updatedAt = ? WHERE id = ?`,
        [result.lastID, nowIso, studentId]
    );
    return result.lastID;
}

async function removeDeadPetRecord(studentId, petId, nowIso = new Date().toISOString()) {
    await dbRun(`DELETE FROM pet_garden_pet_records WHERE id = ? AND student_id = ?`, [petId, studentId]);
    const remainingPets = await listStudentPetRecords(studentId);
    if (remainingPets.length === 0) {
        await createPetGardenEggRecord(studentId, nowIso);
        return;
    }

    const student = await dbGet(`SELECT current_pet_id FROM pet_garden_students WHERE id = ?`, [studentId]);
    if (!student || !remainingPets.some(pet => pet.id === student.current_pet_id)) {
        await dbRun(
            `UPDATE pet_garden_students SET current_pet_id = ?, updatedAt = ? WHERE id = ?`,
            [remainingPets[0].id, nowIso, studentId]
        );
    }
}

async function syncStudentPetRecords(studentId, options = {}) {
	const withEvents = !!options.withEvents;
    const now = new Date();
    const nowIso = now.toISOString();
    let rows = await listStudentPetRecords(studentId);
    if (rows.length === 0) {
        await createPetGardenEggRecord(studentId, nowIso);
        const nextRows = await listStudentPetRecords(studentId);
        return withEvents ? { rows: nextRows, death_events: [] } : nextRows;
    }

    const deadPets = [];
    let hasStatUpdates = false;

    for (const row of rows) {
        if (!row.pet_type) continue;
        const currentSatiety = roundPetStat(row.satiety);
        const currentGrowth = roundPetStat(row.growth_value);
        const currentLevel = Number(row.level) || 0;
        if (currentSatiety <= 0) {
            deadPets.push(row);
            continue;
        }
        const marker = row.satiety_updated_at || row.adopted_at || row.updatedAt || row.createdAt;
        const lastSatietyAt = marker ? new Date(marker) : now;
        if (Number.isNaN(lastSatietyAt.getTime())) continue;
        const elapsedHours = (now.getTime() - lastSatietyAt.getTime()) / (1000 * 60 * 60);
        if (elapsedHours <= 0) continue;

        const autoState = applyTimedPetAutoChanges(row.level, row.growth_value, row.satiety, elapsedHours);
        if (autoState.satiety <= 0) {
            deadPets.push(row);
            continue;
        }
        if (
            Math.abs(autoState.satiety - currentSatiety) < 0.01 &&
            Math.abs(autoState.growth_value - currentGrowth) < 0.01 &&
            autoState.level === currentLevel
        ) continue;

        hasStatUpdates = true;
        await dbRun(
            `UPDATE pet_garden_pet_records SET level = ?, growth_value = ?, satiety = ?, satiety_updated_at = ?, updatedAt = ? WHERE id = ?`,
            [autoState.level, autoState.growth_value, autoState.satiety, nowIso, nowIso, row.id]
        );
    }

    const deathEvents = [];
    if (deadPets.length > 0 && withEvents) {
        const student = await dbGet(`SELECT name FROM pet_garden_students WHERE id = ?`, [studentId]);
        for (const pet of deadPets) {
            const petTypeName = (PET_GARDEN_TYPES.find(t => t.id === pet.pet_type) || {}).name || '';
            const petLabel = pet.pet_name || petTypeName || '宠物';
            deathEvents.push({
                student_id: studentId,
                student_name: student ? student.name : '',
                pet_id: pet.id,
                pet_type: pet.pet_type || null,
                pet_type_name: petTypeName,
                pet_name: pet.pet_name || null,
                message: `${student ? student.name : '该学生'}的${petLabel}饿死了`
            });
        }
    }

    for (const pet of deadPets) {
	    await removeDeadPetRecord(studentId, pet.id, nowIso);
    }

    if (deadPets.length > 0 || hasStatUpdates) {
        rows = await listStudentPetRecords(studentId);
    }
    return withEvents ? { rows, death_events: deathEvents } : rows;
}

async function ensureStudentCurrentPetId(studentId) {
    const student = await dbGet(`SELECT id, current_pet_id FROM pet_garden_students WHERE id = ?`, [studentId]);
    if (!student) return null;

    if (student.current_pet_id) {
        const exists = await dbGet(`SELECT id FROM pet_garden_pet_records WHERE id = ? AND student_id = ?`, [student.current_pet_id, studentId]);
        if (exists) return student.current_pet_id;
    }

    const firstPet = await dbGet(`SELECT id FROM pet_garden_pet_records WHERE student_id = ? ORDER BY id ASC LIMIT 1`, [studentId]);
    if (!firstPet) return null;

    await dbRun(
        `UPDATE pet_garden_students SET current_pet_id = ?, updatedAt = ? WHERE id = ?`,
        [firstPet.id, new Date().toISOString(), studentId]
    );
    return firstPet.id;
}

async function getStudentCurrentPetRecord(studentId) {
    await syncStudentPetRecords(studentId);
    const currentPetId = await ensureStudentCurrentPetId(studentId);
    if (!currentPetId) return null;
    return dbGet(
        `SELECT id, student_id, pet_type, pet_name, level, growth_value, satiety, satiety_updated_at, adopted_at, createdAt, updatedAt
         FROM pet_garden_pet_records
         WHERE id = ? AND student_id = ?`,
        [currentPetId, studentId]
    );
}

async function getStudentTargetPetRecord(studentId, petId = null) {
    await syncStudentPetRecords(studentId);
    if (petId) {
        return dbGet(
            `SELECT id, student_id, pet_type, pet_name, level, growth_value, satiety, satiety_updated_at, adopted_at, createdAt, updatedAt
             FROM pet_garden_pet_records
             WHERE id = ? AND student_id = ?`,
            [petId, studentId]
        );
    }
    return getStudentCurrentPetRecord(studentId);
}

async function buildStudentPetState(studentId, options = {}) {
    if (!options.skipSync) {
        await syncStudentPetRecords(studentId);
    }
    const currentPetId = await ensureStudentCurrentPetId(studentId);
    const pets = (options.rows || await listStudentPetRecords(studentId)).map(buildPetGardenPetPayload);
    return {
        current_pet_id: currentPetId,
        pet_count: pets.length,
        can_add_pet: canAddExtraPet(pets),
        current_pet: pets.find(pet => pet.id === currentPetId) || pets[0] || null,
        pets
    };
}

async function migratePetGardenPetData() {
    try {
        const newTableCount = await dbGet(`SELECT COUNT(*) AS cnt FROM pet_garden_pet_records`);
        const oldTableCount = await dbGet(`SELECT COUNT(*) AS cnt FROM pet_garden_pets`);

        if ((newTableCount?.cnt || 0) === 0 && (oldTableCount?.cnt || 0) > 0) {
            const oldRows = await dbAll(
                `SELECT student_id, pet_type, pet_name, level, growth_value, satiety, satiety_updated_at, adopted_at, createdAt, updatedAt
                 FROM pet_garden_pets
                 ORDER BY student_id ASC, id ASC`
            );
            for (const row of oldRows) {
                const result = await dbRun(
                    `INSERT INTO pet_garden_pet_records (student_id, pet_type, pet_name, level, growth_value, satiety, satiety_updated_at, adopted_at, createdAt, updatedAt)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        row.student_id,
                        row.pet_type || null,
                        row.pet_name || null,
                        row.level != null ? row.level : 0,
                        row.growth_value != null ? row.growth_value : 0,
                        row.satiety != null ? row.satiety : 100,
                        row.satiety_updated_at || row.adopted_at || row.updatedAt || row.createdAt || new Date().toISOString(),
                        row.adopted_at || null,
                        row.createdAt || new Date().toISOString(),
                        row.updatedAt || new Date().toISOString()
                    ]
                );
                await dbRun(
                    `UPDATE pet_garden_students SET current_pet_id = COALESCE(current_pet_id, ?) WHERE id = ?`,
                    [result.lastID, row.student_id]
                );
            }
        }

        const students = await dbAll(`SELECT id FROM pet_garden_students`);
        for (const student of students) {
            await ensureStudentCurrentPetId(student.id);
        }
    } catch (err) {
        console.error('班级宠物园多宠物迁移失败:', err.message);
    }
}

migratePetGardenPetData();

// ========== 班级宠物园 — 班级管理 API ==========

// 获取所有宠物类型
app.get('/api/petgarden/pet/types', (req, res) => {
    res.json({ success: true, types: PET_GARDEN_TYPES });
});

// 获取教师的所有班级
app.get('/api/petgarden/class/list', async (req, res) => {
    const { owner_username } = req.query;
    if (!owner_username) return res.status(400).json({ error: '缺少 owner_username' });
    try {
        const classes = await dbAll(
            `SELECT c.*, (SELECT COUNT(*) FROM pet_garden_students WHERE class_id = c.id) AS student_count
             FROM pet_garden_classes c WHERE c.owner_username = ? ORDER BY c.updatedAt DESC`,
            [owner_username]
        );
        res.json({ success: true, classes });
    } catch (err) {
        res.status(500).json({ error: '获取班级列表失败: ' + err.message });
    }
});

// 创建班级
app.post('/api/petgarden/class/create', async (req, res) => {
    const { owner_username, name } = req.body;
    if (!owner_username || !name) return res.status(400).json({ error: '缺少必填参数' });
    try {
        const now = new Date().toISOString();
        const result = await dbRun(
            `INSERT INTO pet_garden_classes (owner_username, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)`,
            [owner_username, name.trim(), now, now]
        );
        res.json({ success: true, classId: result.lastID });
    } catch (err) {
        res.status(500).json({ error: '创建班级失败: ' + err.message });
    }
});

// 更新班级名称
app.post('/api/petgarden/class/update', async (req, res) => {
    const { id, owner_username, name } = req.body;
    if (!id || !owner_username || !name) return res.status(400).json({ error: '缺少必填参数' });
    try {
        const cls = await dbGet(`SELECT id FROM pet_garden_classes WHERE id = ? AND owner_username = ?`, [id, owner_username]);
        if (!cls) return res.status(404).json({ error: '班级不存在或无权操作' });
        await dbRun(`UPDATE pet_garden_classes SET name = ?, updatedAt = ? WHERE id = ?`, [name.trim(), new Date().toISOString(), id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '更新班级失败: ' + err.message });
    }
});

// 删除班级（同时删除所有学生和宠物）
app.post('/api/petgarden/class/delete', async (req, res) => {
    const { id, owner_username } = req.body;
    if (!id || !owner_username) return res.status(400).json({ error: '缺少必填参数' });
    try {
        const cls = await dbGet(`SELECT id FROM pet_garden_classes WHERE id = ? AND owner_username = ?`, [id, owner_username]);
        if (!cls) return res.status(404).json({ error: '班级不存在或无权操作' });
        // 先删除宠物，再删除学生，最后删除班级
        await dbRun(`DELETE FROM pet_garden_pet_records WHERE student_id IN (SELECT id FROM pet_garden_students WHERE class_id = ?)`, [id]);
        await dbRun(`DELETE FROM pet_garden_pets WHERE student_id IN (SELECT id FROM pet_garden_students WHERE class_id = ?)`, [id]);
        await dbRun(`DELETE FROM pet_garden_students WHERE class_id = ?`, [id]);
        await dbRun(`DELETE FROM pet_garden_classes WHERE id = ?`, [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '删除班级失败: ' + err.message });
    }
});

// 设置班级锁屏密码和安全码
app.post('/api/petgarden/class/set-lock', async (req, res) => {
    const { id, owner_username, lock_password, security_code } = req.body;
    if (!id || !owner_username) return res.status(400).json({ error: '缺少必填参数' });
    try {
        const cls = await dbGet(`SELECT id FROM pet_garden_classes WHERE id = ? AND owner_username = ?`, [id, owner_username]);
        if (!cls) return res.status(404).json({ error: '班级不存在或无权操作' });
        await dbRun(
            `UPDATE pet_garden_classes SET lock_password = ?, security_code = ?, updatedAt = ? WHERE id = ?`,
            [lock_password || null, security_code || null, new Date().toISOString(), id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '设置密码失败: ' + err.message });
    }
});

// ========== 班级宠物园 — 学生管理 API ==========

// 搜索后端学生（从 students 和 registered_stu 表中搜索，供教师选择添加）
app.post('/api/petgarden/student/search-candidates', async (req, res) => {
    const { owner_username, keyword } = req.body;
    if (!owner_username) return res.status(400).json({ error: '缺少 owner_username' });
    try {
        const kw = String(keyword || '').trim();
        const likeKeyword = `%${kw.replace(/[%_]/g, '\\$&')}%`;
        const rows = await dbAll(
            `
            SELECT username, 'permanent' AS type, grade_stu, NULL AS status
            FROM students
            WHERE COALESCE(isTeacher, 0) = 0 AND username LIKE ? ESCAPE '\\'
            UNION ALL
            SELECT username, 'registered' AS type, grade_stu, status
            FROM registered_stu
            WHERE COALESCE(isTeacher, 0) = 0 AND username LIKE ? ESCAPE '\\'
            ORDER BY username COLLATE NOCASE ASC
            LIMIT 80
            `,
            [likeKeyword, likeKeyword]
        );
        return res.json({
            success: true,
            candidates: rows.map(row => ({
                username: row.username,
                type: row.type,
                grade_stu: row.grade_stu || '',
                status: row.status
            }))
        });
    } catch (err) {
        res.status(500).json({ error: '搜索学生失败: ' + err.message });
    }
});

// 添加单个学生（从后端学生表中选择，自动创建宠物蛋，自动关联账号）
// 参数: class_id, linked_username, linked_type, student_number(可选)
app.post('/api/petgarden/student/add', async (req, res) => {
    const { class_id, linked_username, linked_type, student_number } = req.body;
    if (!class_id || !linked_username || !linked_type) {
        return res.status(400).json({ error: '缺少必填参数' });
    }
    if (!['permanent', 'registered'].includes(linked_type)) {
        return res.status(400).json({ error: '无效的学生类型' });
    }
    try {
        const cls = await dbGet(`SELECT id FROM pet_garden_classes WHERE id = ?`, [class_id]);
        if (!cls) return res.status(404).json({ error: '班级不存在' });
        // 重复检查：同一班级不能添加相同的后端学生
        const dup = await dbGet(
            `SELECT id FROM pet_garden_students WHERE class_id = ? AND linked_username = ? AND linked_type = ?`,
            [class_id, linked_username, linked_type]
        );
        if (dup) return res.status(409).json({ error: '该学生已在此班级中' });
        // 用 username 作为显示名称
        const name = linked_username;
        const now = new Date().toISOString();
        const maxSort = await dbGet(`SELECT MAX(sort_order) AS ms FROM pet_garden_students WHERE class_id = ?`, [class_id]);
        const nextSort = (maxSort && maxSort.ms != null) ? maxSort.ms + 1 : 0;
        const result = await dbRun(
            `INSERT INTO pet_garden_students (class_id, name, student_number, sort_order, linked_username, linked_type, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [class_id, name, student_number ? student_number.trim() : null, nextSort, linked_username, linked_type, now, now]
        );
        const studentId = result.lastID;
        // 自动创建初始宠物蛋记录，并设为当前展示宠物
        const petResult = await dbRun(
            `INSERT INTO pet_garden_pet_records (student_id, level, growth_value, satiety, satiety_updated_at, createdAt, updatedAt)
             VALUES (?, 0, 0, 100, ?, ?, ?)`,
            [studentId, now, now, now]
        );
        await dbRun(`UPDATE pet_garden_students SET current_pet_id = ? WHERE id = ?`, [petResult.lastID, studentId]);
        res.json({ success: true, studentId, name });
    } catch (err) {
        res.status(500).json({ error: '添加学生失败: ' + err.message });
    }
});

// 批量添加学生（从后端学生表中批量选择）
// 参数: class_id, students: [{ username, type, student_number? }]
app.post('/api/petgarden/student/batch-add', async (req, res) => {
    const { class_id, students } = req.body;
    if (!class_id || !Array.isArray(students) || students.length === 0) {
        return res.status(400).json({ error: '缺少必填参数' });
    }
    try {
        const cls = await dbGet(`SELECT id FROM pet_garden_classes WHERE id = ?`, [class_id]);
        if (!cls) return res.status(404).json({ error: '班级不存在' });
        const now = new Date().toISOString();
        const maxSort = await dbGet(`SELECT MAX(sort_order) AS ms FROM pet_garden_students WHERE class_id = ?`, [class_id]);
        let nextSort = (maxSort && maxSort.ms != null) ? maxSort.ms + 1 : 0;
        const added = [];
        const skipped = [];
        for (const stu of students) {
            if (!stu.username || !stu.type) continue;
            if (!['permanent', 'registered'].includes(stu.type)) continue;
            // 重复检查
            const dup = await dbGet(
                `SELECT id FROM pet_garden_students WHERE class_id = ? AND linked_username = ? AND linked_type = ?`,
                [class_id, stu.username, stu.type]
            );
            if (dup) {
                skipped.push({ username: stu.username, type: stu.type, reason: '已在班级中' });
                continue;
            }
            const result = await dbRun(
                `INSERT INTO pet_garden_students (class_id, name, student_number, sort_order, linked_username, linked_type, createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [class_id, stu.username, stu.student_number ? stu.student_number.trim() : null, nextSort++, stu.username, stu.type, now, now]
            );
            const studentId = result.lastID;
            const petResult = await dbRun(
                `INSERT INTO pet_garden_pet_records (student_id, level, growth_value, satiety, satiety_updated_at, createdAt, updatedAt)
                 VALUES (?, 0, 0, 100, ?, ?, ?)`,
                [studentId, now, now, now]
            );
            await dbRun(`UPDATE pet_garden_students SET current_pet_id = ? WHERE id = ?`, [petResult.lastID, studentId]);
            added.push({ studentId, username: stu.username, type: stu.type });
        }
        res.json({ success: true, added, skipped });
    } catch (err) {
        res.status(500).json({ error: '批量添加学生失败: ' + err.message });
    }
});

// 确保或创建当前关联账号对应的 pet_garden_students（个人端领养时使用）
// 参数: username, password
app.post('/api/petgarden/student/ensure-for-account', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '').trim();
    if (!username || !password) return res.status(400).json({ error: '缺少账号信息' });
    try {
        const account = await validateGameselfAccount({ username, password });
        // account.source === 'permanent' | 'registered'
        const linked_username = username;
        const linked_type = account.source;

        // 已存在则直接返回
        const existing = await dbGet(`SELECT id FROM pet_garden_students WHERE linked_username = ? AND linked_type = ? LIMIT 1`, [linked_username, linked_type]);
        if (existing) return res.json({ success: true, studentId: existing.id, created: false });

        const now = new Date().toISOString();
        // 将 class_id 设为 NULL，后续由教师端补全
        const maxSort = await dbGet(`SELECT MAX(sort_order) AS ms FROM pet_garden_students WHERE class_id IS NULL`);
        const nextSort = (maxSort && maxSort.ms != null) ? maxSort.ms + 1 : 0;
        const result = await dbRun(
            `INSERT INTO pet_garden_students (class_id, name, student_number, sort_order, linked_username, linked_type, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [null, linked_username, null, nextSort, linked_username, linked_type, now, now]
        );
        const studentId = result.lastID;
        // 创建初始宠物蛋并设为当前宠物
        const petResult = await dbRun(
            `INSERT INTO pet_garden_pet_records (student_id, level, growth_value, satiety, satiety_updated_at, createdAt, updatedAt)
             VALUES (?, 0, 0, 100, ?, ?, ?)`,
            [studentId, now, now, now]
        );
        await dbRun(`UPDATE pet_garden_students SET current_pet_id = ? WHERE id = ?`, [petResult.lastID, studentId]);
        res.json({ success: true, studentId, created: true });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message || '确保学生记录失败' });
    }
});

// 删除学生（仅从 pet_garden_students 和 pet_garden_pets 中移除，绝不影响 students/registered_stu 表）
app.post('/api/petgarden/student/remove', async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: '缺少学生 id' });
    try {
        await dbRun(`DELETE FROM pet_garden_pet_records WHERE student_id = ?`, [id]);
        await dbRun(`DELETE FROM pet_garden_pets WHERE student_id = ?`, [id]);
        await dbRun(`DELETE FROM pet_garden_students WHERE id = ?`, [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '删除学生失败: ' + err.message });
    }
});

// 更新学生学号
app.post('/api/petgarden/student/update', async (req, res) => {
    const { id, student_number } = req.body;
    if (!id) return res.status(400).json({ error: '缺少必填参数' });
    try {
        await dbRun(
            `UPDATE pet_garden_students SET student_number = ?, updatedAt = ? WHERE id = ?`,
            [student_number ? student_number.trim() : null, new Date().toISOString(), id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '更新学生信息失败: ' + err.message });
    }
});

// ========== 班级宠物园 — 获取班级内所有学生和宠物数据（教师页面用） ==========

app.get('/api/petgarden/class/students', async (req, res) => {
    const { class_id } = req.query;
    if (!class_id) return res.status(400).json({ error: '缺少 class_id' });
    try {
        const students = await dbAll(
            `SELECT s.id, s.name, s.student_number, s.sort_order, s.linked_username, s.linked_type, s.current_pet_id,
                    p.id AS pet_id, p.pet_type, p.pet_name, p.level, p.growth_value, p.satiety, p.adopted_at
             FROM pet_garden_students s
             LEFT JOIN pet_garden_pet_records p ON p.id = s.current_pet_id
             WHERE s.class_id = ?
             ORDER BY s.sort_order ASC, s.id ASC`,
            [class_id]
        );
        const result = [];
        const deathEvents = [];
        for (const student of students) {
            const syncResult = await syncStudentPetRecords(student.id, { withEvents: true });
            const petState = await buildStudentPetState(student.id, { skipSync: true, rows: syncResult.rows });
            const currentPet = petState.current_pet;
            deathEvents.push(...(syncResult.death_events || []));
            result.push({
                ...student,
                current_pet_id: petState.current_pet_id,
                pet_count: petState.pet_count,
                can_add_pet: petState.can_add_pet,
                pets: petState.pets,
                pet_id: currentPet ? currentPet.id : null,
                pet_type: currentPet ? currentPet.pet_type : null,
                pet_type_name: currentPet ? currentPet.pet_type_name : '',
                pet_name: currentPet ? currentPet.pet_name : null,
                level: currentPet ? currentPet.level : 0,
                growth_value: currentPet ? currentPet.growth_value : 0,
                satiety: currentPet ? currentPet.satiety : 100,
                adopted_at: currentPet ? currentPet.adopted_at : null,
                max_growth_value: currentPet ? currentPet.max_growth_value : getPetMaxGrowth(0),
                pet_image: currentPet ? currentPet.pet_image : getPetImagePath(null, 0)
            });
        }
        res.json({ success: true, students: result, death_events: deathEvents });
    } catch (err) {
        res.status(500).json({ error: '获取学生列表失败: ' + err.message });
    }
});

// ========== 班级宠物园 — 宠物操作 API ==========

// 领养宠物（从蛋变成具体宠物）
app.post('/api/petgarden/pet/adopt', async (req, res) => {
    const { student_id, pet_type, pet_name, pet_id } = req.body;
    if (!student_id || !pet_type) return res.status(400).json({ error: '缺少必填参数' });
    // 验证宠物类型合法
    if (!PET_GARDEN_TYPES.find(t => t.id === pet_type)) {
        return res.status(400).json({ error: '无效的宠物类型' });
    }
    try {
        const pet = await getStudentTargetPetRecord(student_id, pet_id || null);
        if (!pet) return res.status(404).json({ error: '未找到该学生的宠物记录' });
        if (pet.pet_type) return res.status(400).json({ error: '该学生已经领养了宠物' });
        const now = new Date().toISOString();
        await dbRun(
            `UPDATE pet_garden_pet_records SET pet_type = ?, pet_name = ?, level = 0, growth_value = 0, satiety = 100, satiety_updated_at = ?, adopted_at = ?, updatedAt = ? WHERE id = ?`,
            [pet_type, pet_name ? pet_name.trim() : null, now, now, now, pet.id]
        );
        await dbRun(`UPDATE pet_garden_students SET current_pet_id = ? WHERE id = ?`, [pet.id, student_id]);
        res.json({
            success: true,
            pet_id: pet.id,
            level: 0,
            growth_value: 0,
            max_growth_value: getPetMaxGrowth(0),
            pet_image: getPetImagePath(pet_type, 0)
        });
    } catch (err) {
        res.status(500).json({ error: '领养宠物失败: ' + err.message });
    }
});

// 获取单个学生的宠物数据
app.get('/api/petgarden/pet/data', async (req, res) => {
    const { student_id } = req.query;
    if (!student_id) return res.status(400).json({ error: '缺少 student_id' });
    try {
        const row = await dbGet(`SELECT id AS student_id, name AS student_name, student_number, current_pet_id FROM pet_garden_students WHERE id = ?`, [student_id]);
        if (!row) return res.status(404).json({ error: '学生不存在' });
        const petState = await buildStudentPetState(student_id);
        const currentPet = petState.current_pet;
        res.json({
            success: true,
            data: {
                ...row,
                pet_count: petState.pet_count,
                can_add_pet: petState.can_add_pet,
                pets: petState.pets,
                pet_id: currentPet ? currentPet.id : null,
                pet_type: currentPet ? currentPet.pet_type : null,
                pet_type_name: currentPet ? currentPet.pet_type_name : '',
                pet_name: currentPet ? currentPet.pet_name : null,
                level: currentPet ? currentPet.level : 0,
                growth_value: currentPet ? currentPet.growth_value : 0,
                satiety: currentPet ? currentPet.satiety : 100,
                adopted_at: currentPet ? currentPet.adopted_at : null,
                max_growth_value: currentPet ? currentPet.max_growth_value : getPetMaxGrowth(0),
                pet_image: currentPet ? currentPet.pet_image : getPetImagePath(null, 0)
            }
        });
    } catch (err) {
        res.status(500).json({ error: '获取宠物数据失败: ' + err.message });
    }
});

// 通过关联账号获取宠物数据（个人中心用）
app.post('/api/petgarden/pet/profile', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '缺少账号信息' });
    try {
        // 验证账号（复用已有逻辑）
        const account = await validateGameselfAccount(username, password);
        if (!account.valid) return res.status(401).json({ error: account.error || '账号验证失败' });
        const displayUserId = getPermanentDisplayUserId(account);
        // 查找关联的宠物园学生
        const rows = await dbAll(
            `SELECT s.id AS student_id, s.name AS student_name, s.student_number, s.class_id,
                    c.name AS class_name, s.current_pet_id
             FROM pet_garden_students s
             LEFT JOIN pet_garden_classes c ON c.id = s.class_id
             WHERE s.linked_username = ? AND s.linked_type = ?`,
            [displayUserId, account.type]
        );
        const result = [];
        for (const row of rows) {
            const petState = await buildStudentPetState(row.student_id);
            const currentPet = petState.current_pet;
            result.push({
                ...row,
                pet_count: petState.pet_count,
                can_add_pet: petState.can_add_pet,
                pets: petState.pets,
                pet_id: currentPet ? currentPet.id : null,
                pet_type: currentPet ? currentPet.pet_type : null,
                pet_type_name: currentPet ? currentPet.pet_type_name : '',
                pet_name: currentPet ? currentPet.pet_name : null,
                level: currentPet ? currentPet.level : 0,
                growth_value: currentPet ? currentPet.growth_value : 0,
                satiety: currentPet ? currentPet.satiety : 100,
                adopted_at: currentPet ? currentPet.adopted_at : null,
                max_growth_value: currentPet ? currentPet.max_growth_value : getPetMaxGrowth(0),
                pet_image: currentPet ? currentPet.pet_image : getPetImagePath(null, 0)
            });
        }
        res.json({ success: true, pets: result });
    } catch (err) {
        res.status(500).json({ error: '获取宠物资料失败: ' + err.message });
    }
});

// 新增宠物（仅当现有全部宠物达到 5 级及以上时允许）
app.post('/api/petgarden/pet/add-pet', async (req, res) => {
    const { student_id, pet_type, pet_name } = req.body;
    if (!student_id || !pet_type) return res.status(400).json({ error: '缺少必填参数' });
    if (!PET_GARDEN_TYPES.find(t => t.id === pet_type)) {
        return res.status(400).json({ error: '无效的宠物类型' });
    }
    try {
        const student = await dbGet(`SELECT id FROM pet_garden_students WHERE id = ?`, [student_id]);
        if (!student) return res.status(404).json({ error: '学生不存在' });
        const pets = (await listStudentPetRecords(student_id)).map(buildPetGardenPetPayload);
        if (!canAddExtraPet(pets)) {
            return res.status(400).json({ error: '只有当该学生现有的所有宠物都达到 5 级及以上时，才可以添加新宠物' });
        }
        const now = new Date().toISOString();
        const result = await dbRun(
            `INSERT INTO pet_garden_pet_records (student_id, pet_type, pet_name, level, growth_value, satiety, satiety_updated_at, adopted_at, createdAt, updatedAt)
             VALUES (?, ?, ?, 0, 0, 100, ?, ?, ?, ?)`,
            [student_id, pet_type, pet_name ? pet_name.trim() : null, now, now, now, now]
        );
        await dbRun(`UPDATE pet_garden_students SET current_pet_id = ?, updatedAt = ? WHERE id = ?`, [result.lastID, now, student_id]);
        const pet = await getStudentTargetPetRecord(student_id, result.lastID);
        res.json({ success: true, pet: buildPetGardenPetPayload(pet), pet_state: await buildStudentPetState(student_id) });
    } catch (err) {
        res.status(500).json({ error: '添加宠物失败: ' + err.message });
    }
});

// 切换当前展示宠物
app.post('/api/petgarden/pet/set-current', async (req, res) => {
    const { student_id, pet_id } = req.body;
    if (!student_id || !pet_id) return res.status(400).json({ error: '缺少必填参数' });
    try {
        const pet = await getStudentTargetPetRecord(student_id, pet_id);
        if (!pet) return res.status(404).json({ error: '未找到该宠物记录' });
        await dbRun(`UPDATE pet_garden_students SET current_pet_id = ?, updatedAt = ? WHERE id = ?`, [pet.id, new Date().toISOString(), student_id]);
        res.json({ success: true, current_pet_id: pet.id, pet: buildPetGardenPetPayload(pet), pet_state: await buildStudentPetState(student_id) });
    } catch (err) {
        res.status(500).json({ error: '切换当前宠物失败: ' + err.message });
    }
});

// 增加成长值（学习任务完成后调用）
app.post('/api/petgarden/pet/add-growth', async (req, res) => {
    const { student_id, amount, pet_id } = req.body;
    const delta = Number(amount);
    if (!student_id || !Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: '参数无效' });
    try {
        const pet = await getStudentTargetPetRecord(student_id, pet_id || null);
        if (!pet) return res.status(404).json({ error: '未找到宠物记录' });
        if (!pet.pet_type) return res.status(400).json({ error: '该学生尚未领养宠物' });

        const growthState = applyPetGrowthDelta(pet.level, pet.growth_value, delta);
        const now = new Date().toISOString();
        await dbRun(
            `UPDATE pet_garden_pet_records SET level = ?, growth_value = ?, updatedAt = ? WHERE id = ?`,
            [growthState.level, growthState.growth_value, now, pet.id]
        );
        res.json({
            success: true,
            pet_id: pet.id,
            level: growthState.level,
            growth_value: growthState.growth_value,
            max_growth_value: growthState.max_growth_value,
            pet_image: getPetImagePath(pet.pet_type, growthState.level)
        });
    } catch (err) {
        res.status(500).json({ error: '更新成长值失败: ' + err.message });
    }
});

// 增减饱腹度
app.post('/api/petgarden/pet/add-satiety', async (req, res) => {
    const { student_id, amount, pet_id } = req.body;
    const delta = Number(amount);
    if (!student_id || !Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: '参数无效' });
    try {
        const pet = await getStudentTargetPetRecord(student_id, pet_id || null);
        if (!pet) return res.status(404).json({ error: '未找到宠物记录' });
        if (!pet.pet_type) return res.status(400).json({ error: '该学生尚未领养宠物' });

        const newSatiety = applyPetSatietyDelta(pet.satiety, delta);
        const now = new Date().toISOString();
        await dbRun(
            `UPDATE pet_garden_pet_records SET satiety = ?, satiety_updated_at = ?, updatedAt = ? WHERE id = ?`,
            [newSatiety, now, now, pet.id]
        );
        res.json({ success: true, pet_id: pet.id, satiety: newSatiety });
    } catch (err) {
        res.status(500).json({ error: '更新饱腹度失败: ' + err.message });
    }
});

// 喂食宠物（增加饱腹度）
app.post('/api/petgarden/pet/feed', async (req, res) => {
    const { student_id, amount, pet_id } = req.body;
    const delta = Number(amount);
    if (!student_id || !Number.isFinite(delta) || delta <= 0) return res.status(400).json({ error: '参数无效' });
    try {
        const pet = await getStudentTargetPetRecord(student_id, pet_id || null);
        if (!pet) return res.status(404).json({ error: '未找到宠物记录' });
        if (!pet.pet_type) return res.status(400).json({ error: '该学生尚未领养宠物' });

        const newSatiety = applyPetSatietyDelta(pet.satiety, delta);
        const now = new Date().toISOString();
        await dbRun(
            `UPDATE pet_garden_pet_records SET satiety = ?, satiety_updated_at = ?, updatedAt = ? WHERE id = ?`,
            [newSatiety, now, now, pet.id]
        );
        res.json({ success: true, pet_id: pet.id, satiety: newSatiety });
    } catch (err) {
        res.status(500).json({ error: '喂食宠物失败: ' + err.message });
    }
});

// 批量增加成长值（教师给全班加分用）
app.post('/api/petgarden/pet/batch-add-growth', async (req, res) => {
    const { student_ids, amount } = req.body;
    if (!Array.isArray(student_ids) || student_ids.length === 0 || !amount || amount <= 0) {
        return res.status(400).json({ error: '参数无效' });
    }
    try {
        const results = [];
        for (const sid of student_ids) {
            const pet = await getStudentCurrentPetRecord(sid);
            if (!pet || !pet.pet_type) {
                results.push({ student_id: sid, success: false, reason: '未领养宠物' });
                continue;
            }
            const growthState = applyPetGrowthDelta(pet.level, pet.growth_value, Number(amount));
            const now = new Date().toISOString();
            await dbRun(
                `UPDATE pet_garden_pet_records SET level = ?, growth_value = ?, updatedAt = ? WHERE id = ?`,
                [growthState.level, growthState.growth_value, now, pet.id]
            );
            results.push({ student_id: sid, pet_id: pet.id, success: true, level: growthState.level, growth_value: growthState.growth_value, max_growth_value: growthState.max_growth_value });
        }
        res.json({ success: true, results });
    } catch (err) {
        res.status(500).json({ error: '批量增加成长值失败: ' + err.message });
    }
});

// 直接设置宠物数据（教师管理用，可设置等级、成长值、饱腹度）
app.post('/api/petgarden/pet/set-data', async (req, res) => {
    const { student_id, pet_id, level, growth_value, satiety } = req.body;
    if (!student_id) return res.status(400).json({ error: '缺少 student_id' });
    try {
        const pet = await getStudentTargetPetRecord(student_id, pet_id || null);
        if (!pet) return res.status(404).json({ error: '未找到宠物记录' });
        const newLevel = (level != null && level >= 0) ? level : pet.level;
        const newGrowth = (growth_value != null && growth_value >= 0) ? growth_value : pet.growth_value;
        const newSatiety = (satiety != null && satiety >= 0) ? Math.min(satiety, 100) : pet.satiety;
        const now = new Date().toISOString();
        const nextSatietyUpdatedAt = (satiety != null && satiety >= 0) ? now : (pet.satiety_updated_at || pet.adopted_at || pet.updatedAt || pet.createdAt || now);
        await dbRun(
            `UPDATE pet_garden_pet_records SET level = ?, growth_value = ?, satiety = ?, satiety_updated_at = ?, updatedAt = ? WHERE id = ?`,
            [newLevel, newGrowth, newSatiety, nextSatietyUpdatedAt, now, pet.id]
        );
        res.json({
            success: true,
            pet_id: pet.id,
            level: newLevel,
            growth_value: newGrowth,
            max_growth_value: getPetMaxGrowth(newLevel),
            satiety: newSatiety,
            pet_image: getPetImagePath(pet.pet_type, newLevel)
        });
    } catch (err) {
        res.status(500).json({ error: '设置宠物数据失败: ' + err.message });
    }
});

// 更换宠物类型（重新领养，重置等级和成长值）
app.post('/api/petgarden/pet/change-type', async (req, res) => {
    const { student_id, pet_id, pet_type, pet_name } = req.body;
    if (!student_id || !pet_type) return res.status(400).json({ error: '缺少必填参数' });
    if (!PET_GARDEN_TYPES.find(t => t.id === pet_type)) {
        return res.status(400).json({ error: '无效的宠物类型' });
    }
    try {
        const pet = await getStudentTargetPetRecord(student_id, pet_id || null);
        if (!pet) return res.status(404).json({ error: '未找到宠物记录' });
        if ((Number(pet.level) || 0) >= 5) {
            return res.status(400).json({ error: '5级和5级以上的宠物不支持更换' });
        }
        const now = new Date().toISOString();
        await dbRun(
            `UPDATE pet_garden_pet_records SET pet_type = ?, pet_name = ?, level = 0, growth_value = 0, satiety = 100, satiety_updated_at = ?, adopted_at = ?, updatedAt = ? WHERE id = ?`,
            [pet_type, pet_name ? pet_name.trim() : null, now, now, now, pet.id]
        );
        await dbRun(`UPDATE pet_garden_students SET current_pet_id = ?, updatedAt = ? WHERE id = ?`, [pet.id, now, student_id]);
        res.json({
            success: true,
            pet_id: pet.id,
            level: 0,
            growth_value: 0,
            max_growth_value: getPetMaxGrowth(0),
            pet_image: getPetImagePath(pet_type, 0)
        });
    } catch (err) {
        res.status(500).json({ error: '更换宠物失败: ' + err.message });
    }
});

// 养宠排行榜（所有有宠物的学生，按等级+成长值降序）
app.get('/api/petgarden/ranking', async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT r.id AS pet_record_id, r.student_id, r.pet_type, r.pet_name,
                    r.level, r.growth_value, r.satiety, r.satiety_updated_at,
                    r.adopted_at, r.createdAt, r.updatedAt,
                    s.name AS student_name, s.linked_username, s.linked_type,
                    COALESCE(sr.pet_food, 0) AS pet_food
             FROM pet_garden_pet_records r
             JOIN pet_garden_students s ON s.id = r.student_id
             LEFT JOIN student_rewards sr ON sr.username = s.linked_username AND sr.source = s.linked_type
             WHERE r.pet_type IS NOT NULL
             ORDER BY r.level DESC, r.growth_value DESC, r.satiety DESC`
        );
        const list = rows.map(row => {
            const typeInfo = PET_GARDEN_TYPES.find(t => t.id === row.pet_type);
            return {
                student_name: row.student_name,
                pet_name: row.pet_name || (typeInfo ? typeInfo.name : ''),
                pet_type: row.pet_type,
                pet_type_name: typeInfo ? typeInfo.name : '',
                level: row.level,
                growth_value: roundPetStat(row.growth_value),
                max_growth_value: getPetMaxGrowth(row.level),
                satiety: roundPetStat(row.satiety),
                pet_image: getPetImagePath(row.pet_type, row.level),
                pet_food: Number(row.pet_food || 0)
            };
        });
        res.json({ success: true, ranking: list });
    } catch (err) {
        res.status(500).json({ error: '获取排行榜失败: ' + err.message });
    }
});

// 获取指定用户名关联的宠物信息（用于个人中心展示）
app.get('/api/petgarden/my-pets', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: '缺少 username' });
    try {
        // 查找该用户关联的所有宠物园学生记录
        const students = await dbAll(
            `SELECT id, name, class_id, current_pet_id FROM pet_garden_students WHERE linked_username = ?`,
            [username]
        );
        if (!students || students.length === 0) {
            return res.json({ success: true, pets: [] });
        }
        const allPets = [];
        for (const stu of students) {
            await syncStudentPetRecords(stu.id);
            const petState = await buildStudentPetState(stu.id, { skipSync: true });
            for (const pet of petState.pets) {
                pet.is_current = (pet.id === petState.current_pet_id);
                allPets.push(pet);
            }
        }
        res.json({ success: true, pets: allPets });
    } catch (err) {
        res.status(500).json({ error: '获取宠物信息失败: ' + err.message });
    }
});

// =============================================================================
// --- 班级宠物园功能结束 ---
// =============================================================================

// =============================================================================
// --- 学生奖励仓库功能开始 ---
// =============================================================================

// 学生奖励表：存储来自训练页面的奖励物品（宠物主食等）
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS student_rewards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'registered',
        pet_food INTEGER NOT NULL DEFAULT 0,
        updatedAt TEXT NOT NULL,
        UNIQUE(username, source)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS student_pet_feed_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pet_record_id INTEGER NOT NULL,
        feed_type TEXT NOT NULL,
        week_start TEXT NOT NULL,
        quantity_used INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(pet_record_id, feed_type, week_start)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pet_auto_feed_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pet_record_id INTEGER NOT NULL UNIQUE,
        threshold REAL NOT NULL DEFAULT 80,
        enabled INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pet_auto_feed_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        source TEXT NOT NULL,
        pet_id INTEGER,
        pet_name TEXT,
        amount INTEGER,
        satiety_before REAL,
        satiety_after REAL,
        createdAt TEXT NOT NULL
    )`);
});

// 喂食物品配置表：每种物品的饱腹值增量
const FEED_ITEM_CONFIG = {
    candy:    { satietyDelta: 2,  label: '糖果', weeklyLimit: 35 },
    pet_food: { satietyDelta: 10, label: '宠物主食', weeklyLimit: 20 }
};

function getCurrentWeekStartKey(date = new Date()) {
    const current = new Date(date);
    current.setHours(0, 0, 0, 0);
    const day = current.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    current.setDate(current.getDate() + diffToMonday);
    const year = current.getFullYear();
    const month = String(current.getMonth() + 1).padStart(2, '0');
    const dayOfMonth = String(current.getDate()).padStart(2, '0');
    return `${year}-${month}-${dayOfMonth}`;
}

async function getGameselfInventoryCounts(username, source) {
    let candyCount = 0;
    const candyRows = await dbAll(
        `SELECT candies_json FROM choose_game_students WHERE linked_username = ? AND linked_type = ?`,
        [username, source]
    );
    candyRows.forEach(row => {
        candyCount += parseChooseCandiesJson(row.candies_json).length;
    });

    const reward = await getOrCreateStudentReward(username, source);
    return {
        candyCount,
        petFoodCount: reward.pet_food
    };
}

async function getGameselfOwnedPetRecord(username, source, petId) {
    if (!Number.isFinite(Number(petId)) || Number(petId) <= 0) return null;
    const ownerRow = await dbGet(
        `SELECT p.id AS pet_id, s.id AS student_id
         FROM pet_garden_pet_records p
         INNER JOIN pet_garden_students s ON s.id = p.student_id
         WHERE p.id = ? AND s.linked_username = ? AND s.linked_type = ?
         LIMIT 1`,
        [Number(petId), username, source]
    );
    if (!ownerRow) return null;
    await syncStudentPetRecords(ownerRow.student_id);
    return getStudentTargetPetRecord(ownerRow.student_id, ownerRow.pet_id);
}

async function getPetWeeklyFeedUsageSummary(petId, weekStart = getCurrentWeekStartKey()) {
    const rows = await dbAll(
        `SELECT feed_type, quantity_used
         FROM student_pet_feed_usage
         WHERE pet_record_id = ? AND week_start = ?`,
        [petId, weekStart]
    );
    const summary = {};
    Object.keys(FEED_ITEM_CONFIG).forEach(feedType => {
        const used = rows.find(row => row.feed_type === feedType)?.quantity_used || 0;
        const config = FEED_ITEM_CONFIG[feedType];
        summary[feedType] = {
            label: config.label,
            weeklyLimit: config.weeklyLimit,
            used,
            remaining: Math.max(0, config.weeklyLimit - used),
            satietyDelta: config.satietyDelta
        };
    });
    return summary;
}

async function increasePetWeeklyFeedUsage(petId, feedType, quantity, weekStart, nowIso) {
    if (!quantity) return;
    await dbRun(
        `INSERT INTO student_pet_feed_usage (pet_record_id, feed_type, week_start, quantity_used, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(pet_record_id, feed_type, week_start)
         DO UPDATE SET quantity_used = quantity_used + excluded.quantity_used, updatedAt = excluded.updatedAt`,
        [petId, feedType, weekStart, quantity, nowIso, nowIso]
    );
}

// 工具：获取或创建学生奖励记录
async function getOrCreateStudentReward(username, source) {
    const existing = await dbGet(
        `SELECT * FROM student_rewards WHERE username = ? AND source = ?`,
        [username, source]
    );
    if (existing) return existing;
    const now = new Date().toISOString();
    await dbRun(
        `INSERT INTO student_rewards (username, source, pet_food, updatedAt) VALUES (?, ?, 0, ?)`,
        [username, source, now]
    );
    return dbGet(
        `SELECT * FROM student_rewards WHERE username = ? AND source = ?`,
        [username, source]
    );
}

// API：增加宠物主食（训练页面完成后调用）
app.post('/api/gameself/add-pet-food', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const amount = Math.floor(Number(req.body.amount));
    if (!username || !Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: '参数无效' });
    }
    try {
        // 确定用户来源
        let source = 'registered';
        const permanent = await dbGet(`SELECT username FROM students WHERE username = ?`, [username]);
        if (permanent) {
            source = 'permanent';
        } else {
            const registered = await dbGet(`SELECT username FROM registered_stu WHERE username = ?`, [username]);
            if (!registered) return res.status(404).json({ error: '用户不存在' });
        }

        const petGardenStudent = await dbGet(
            `SELECT id FROM pet_garden_students WHERE linked_username = ? AND linked_type = ? LIMIT 1`,
            [username, source]
        );
        if (!petGardenStudent) {
            return res.json({ success: true, rewarded: false, reason: 'student_not_in_pet_garden' });
        }

        const reward = await getOrCreateStudentReward(username, source);
        const newCount = reward.pet_food + amount;
        const now = new Date().toISOString();
        await dbRun(
            `UPDATE student_rewards SET pet_food = ?, updatedAt = ? WHERE id = ?`,
            [newCount, now, reward.id]
        );
        res.json({ success: true, rewarded: true, pet_food: newCount });
    } catch (err) {
        res.status(500).json({ error: '增加宠物主食失败: ' + err.message });
    }
});

// API：减少宠物主食（老师/管理端收回主食时调用）
app.post('/api/gameself/remove-pet-food', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const amount = Math.floor(Number(req.body.amount));
    if (!username || !Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: '参数无效' });
    }
    try {
        // 确定用户来源
        let source = 'registered';
        const permanent = await dbGet(`SELECT username FROM students WHERE username = ?`, [username]);
        if (permanent) {
            source = 'permanent';
        } else {
            const registered = await dbGet(`SELECT username FROM registered_stu WHERE username = ?`, [username]);
            if (!registered) return res.status(404).json({ error: '用户不存在' });
        }

        const petGardenStudent = await dbGet(
            `SELECT id FROM pet_garden_students WHERE linked_username = ? AND linked_type = ? LIMIT 1`,
            [username, source]
        );
        if (!petGardenStudent) {
            return res.json({ success: true, removed: false, reason: 'student_not_in_pet_garden' });
        }

        const reward = await getOrCreateStudentReward(username, source);
        if ((reward.pet_food || 0) < amount) {
            return res.json({ success: true, removed: false, reason: 'not_enough', pet_food: reward.pet_food || 0 });
        }

        const newCount = Math.max(0, (reward.pet_food || 0) - amount);
        const now = new Date().toISOString();
        await dbRun(
            `UPDATE student_rewards SET pet_food = ?, updatedAt = ? WHERE id = ?`,
            [newCount, now, reward.id]
        );
        res.json({ success: true, removed: true, pet_food: newCount });
    } catch (err) {
        res.status(500).json({ error: '减少宠物主食失败: ' + err.message });
    }
});

app.post('/api/gameself/feed-pet-status', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '').trim();
    const deviceId = String(req.body.deviceId || '').trim() || null;
    const petId = Number(req.body.petId);

    if (!Number.isFinite(petId) || petId <= 0) {
        return res.status(400).json({ error: '缺少有效的宠物ID' });
    }

    try {
        const account = await validateGameselfAccount({ username, password, deviceId });
        const pet = await getGameselfOwnedPetRecord(username, account.source, petId);
        if (!pet || !pet.pet_type) {
            return res.status(404).json({ error: '未找到可喂食的宠物' });
        }

        const inventory = await getGameselfInventoryCounts(username, account.source);
        const weeklyQuota = await getPetWeeklyFeedUsageSummary(pet.id);

        res.json({
            success: true,
            pet: {
                id: pet.id,
                name: pet.pet_name || pet.pet_type_name || '宠物',
                typeName: pet.pet_type_name || '',
                satiety: Number(pet.satiety) || 0
            },
            inventory,
            weeklyQuota
        });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message || '获取喂食信息失败' });
    }
});

// API：学生喂食宠物（消耗糖果或宠物主食来增加宠物饱腹度）
// feedType: 'candy' | 'pet_food'
// quantity: 使用数量
app.post('/api/gameself/feed-pet', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '').trim();
    const deviceId = String(req.body.deviceId || '').trim() || null;
    const petId = Number(req.body.petId);
    const rawFoods = req.body.foods && typeof req.body.foods === 'object' ? req.body.foods : null;

    const quantities = rawFoods
        ? Object.keys(FEED_ITEM_CONFIG).reduce((acc, feedType) => {
            acc[feedType] = Math.max(0, Math.floor(Number(rawFoods[feedType] || 0)));
            return acc;
        }, {})
        : (() => {
            const feedType = String(req.body.feedType || '').trim();
            const quantity = Math.max(0, Math.floor(Number(req.body.quantity || 0)));
            return Object.keys(FEED_ITEM_CONFIG).reduce((acc, key) => {
                acc[key] = key === feedType ? quantity : 0;
                return acc;
            }, {});
        })();

    const selectedFeedTypes = Object.keys(quantities).filter(feedType => quantities[feedType] > 0);
    if (!Number.isFinite(petId) || petId <= 0) {
        return res.status(400).json({ error: '缺少有效的宠物ID' });
    }
    if (selectedFeedTypes.length === 0) {
        return res.status(400).json({ error: '请至少选择一种食物并填写数量' });
    }

    try {
        const account = await validateGameselfAccount({ username, password, deviceId });
        const pet = await getGameselfOwnedPetRecord(username, account.source, petId);
        if (!pet || !pet.pet_type) {
            return res.status(404).json({ error: '未找到可喂食的宠物' });
        }

        const inventory = await getGameselfInventoryCounts(username, account.source);
        const weekStart = getCurrentWeekStartKey();
        const weeklyQuotaBefore = await getPetWeeklyFeedUsageSummary(pet.id, weekStart);
        const totalSatietyDelta = selectedFeedTypes.reduce((sum, feedType) => {
            return sum + FEED_ITEM_CONFIG[feedType].satietyDelta * quantities[feedType];
        }, 0);

        selectedFeedTypes.forEach(feedType => {
            const requested = quantities[feedType];
            const quota = weeklyQuotaBefore[feedType];
            if (requested > quota.remaining) {
                throw createHttpError(400, `${quota.label}本周剩余可喂数量不足，当前还可使用 ${quota.remaining} 个`);
            }
            if (feedType === 'candy' && requested > inventory.candyCount) {
                throw createHttpError(400, `糖果不足，需要 ${requested} 个，当前只有 ${inventory.candyCount} 个`);
            }
            if (feedType === 'pet_food' && requested > inventory.petFoodCount) {
                throw createHttpError(400, `宠物主食不足，需要 ${requested} 个，当前只有 ${inventory.petFoodCount} 个`);
            }
        });

        let transactionStarted = false;
        try {
            await dbRun('BEGIN IMMEDIATE TRANSACTION');
            transactionStarted = true;

            if (quantities.candy > 0) {
                const rows = await dbAll(
                    `SELECT id, candies_json FROM choose_game_students WHERE linked_username = ? AND linked_type = ? ORDER BY datetime(updatedAt) DESC, id DESC`,
                    [username, account.source]
                );
                const normalizedRows = rows.map(row => ({ id: row.id, candies: parseChooseCandiesJson(row.candies_json) }));
                let remaining = quantities.candy;
                for (const row of normalizedRows) {
                    if (remaining <= 0) break;
                    const removable = Math.min(remaining, row.candies.length);
                    if (removable > 0) {
                        row.candies = row.candies.slice(0, row.candies.length - removable);
                        remaining -= removable;
                    }
                }
                const now = new Date().toISOString();
                for (const row of normalizedRows) {
                    await dbRun(
                        `UPDATE choose_game_students SET candies_json = ?, updatedAt = ? WHERE id = ?`,
                        [JSON.stringify(row.candies), now, row.id]
                    );
                }
            }

            if (quantities.pet_food > 0) {
                const reward = await getOrCreateStudentReward(username, account.source);
                const now = new Date().toISOString();
                await dbRun(
                    `UPDATE student_rewards SET pet_food = pet_food - ?, updatedAt = ? WHERE id = ?`,
                    [quantities.pet_food, now, reward.id]
                );
            }

            const now = new Date().toISOString();
            const newSatiety = applyPetSatietyDelta(pet.satiety, totalSatietyDelta);
            await dbRun(
                `UPDATE pet_garden_pet_records SET satiety = ?, satiety_updated_at = ?, updatedAt = ? WHERE id = ?`,
                [newSatiety, now, now, pet.id]
            );

            for (const feedType of selectedFeedTypes) {
                await increasePetWeeklyFeedUsage(pet.id, feedType, quantities[feedType], weekStart, now);
            }

            await dbRun('COMMIT');
            transactionStarted = false;

            const updatedInventory = await getGameselfInventoryCounts(username, account.source);
            const weeklyQuotaAfter = await getPetWeeklyFeedUsageSummary(pet.id, weekStart);

            res.json({
                success: true,
                fed: {
                    pet_id: pet.id,
                    pet_name: pet.pet_name || pet.pet_type_name || '宠物',
                    items: selectedFeedTypes.map(feedType => ({
                        feedType,
                        label: FEED_ITEM_CONFIG[feedType].label,
                        quantity: quantities[feedType],
                        satietyAdded: FEED_ITEM_CONFIG[feedType].satietyDelta * quantities[feedType]
                    })),
                    satietyAdded: totalSatietyDelta,
                    newSatiety
                },
                inventory: updatedInventory,
                weeklyQuota: weeklyQuotaAfter
            });
        } catch (innerErr) {
            if (transactionStarted) {
                try {
                    await dbRun('ROLLBACK');
                } catch (rollbackErr) {
                    console.error('喂食事务回滚失败:', rollbackErr.message);
                }
            }
            throw innerErr;
        }
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message || '喂食失败' });
    }
});

// =============================================================================
// --- 学生奖励仓库功能结束 ---
// =============================================================================

// =============================================================================
// --- 自动喂食系统 ---
// =============================================================================

// 内部喂食函数（不走HTTP，由调度器直接调用）
async function feedPetInternal(petId, username, source, quantities) {
    const pet = await getGameselfOwnedPetRecord(username, source, petId);
    if (!pet || !pet.pet_type) throw new Error('未找到可喂食的宠物');

    const selectedFeedTypes = Object.keys(quantities).filter(ft => quantities[ft] > 0);
    if (selectedFeedTypes.length === 0) throw new Error('没有需要喂食的数量');

    const inventory = await getGameselfInventoryCounts(username, source);
    const weekStart = getCurrentWeekStartKey();
    const weeklyQuotaBefore = await getPetWeeklyFeedUsageSummary(pet.id, weekStart);

    for (const feedType of selectedFeedTypes) {
        const requested = quantities[feedType];
        const quota = weeklyQuotaBefore[feedType];
        if (requested > quota.remaining) {
            throw new Error(`${quota.label}本周配额不足（剩余 ${quota.remaining} 个）`);
        }
        if (feedType === 'candy' && requested > inventory.candyCount) {
            throw new Error(`糖果不足（需要 ${requested}，当前 ${inventory.candyCount}）`);
        }
        if (feedType === 'pet_food' && requested > inventory.petFoodCount) {
            throw new Error(`宠物主食不足（需要 ${requested}，当前 ${inventory.petFoodCount}）`);
        }
    }

    const totalSatietyDelta = selectedFeedTypes.reduce((sum, ft) =>
        sum + FEED_ITEM_CONFIG[ft].satietyDelta * quantities[ft], 0);

    let transactionStarted = false;
    try {
        await dbRun('BEGIN IMMEDIATE TRANSACTION');
        transactionStarted = true;

        if (quantities.pet_food > 0) {
            const reward = await getOrCreateStudentReward(username, source);
            const now = new Date().toISOString();
            await dbRun(
                `UPDATE student_rewards SET pet_food = pet_food - ?, updatedAt = ? WHERE id = ?`,
                [quantities.pet_food, now, reward.id]
            );
        }

        const now = new Date().toISOString();
        const newSatiety = applyPetSatietyDelta(pet.satiety, totalSatietyDelta);
        await dbRun(
            `UPDATE pet_garden_pet_records SET satiety = ?, satiety_updated_at = ?, updatedAt = ? WHERE id = ?`,
            [newSatiety, now, now, pet.id]
        );

        for (const feedType of selectedFeedTypes) {
            await increasePetWeeklyFeedUsage(pet.id, feedType, quantities[feedType], weekStart, now);
        }

        await dbRun('COMMIT');
        transactionStarted = false;
        return { pet_id: pet.id, newSatiety, fed: quantities.pet_food || 0 };
    } catch (err) {
        if (transactionStarted) {
            try { await dbRun('ROLLBACK'); } catch {}
        }
        throw err;
    }
}

// API：获取当前用户所有宠物的自动喂食配置
app.post('/api/gameself/auto-feed-config/list', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '').trim();
    const deviceId = String(req.body.deviceId || '').trim() || null;
    try {
        const account = await validateGameselfAccount({ username, password, deviceId });

        // 获取该用户所有关联的学生记录（可能处于多个班级），汇总这些学生的宠物
        const students = await dbAll(
            `SELECT id FROM pet_garden_students WHERE linked_username = ?`,
            [username]
        );
        if (!students || students.length === 0) return res.json({ success: true, pets: [] });

        // 对每个学生执行同步，确保本地记录是最新的
        for (const stu of students) {
            await syncStudentPetRecords(stu.id);
        }

        const studentIds = students.map(s => s.id);
        const placeholders = studentIds.map(() => '?').join(',') || 'NULL';
        const petRows = await dbAll(
            `SELECT p.id, p.pet_type, p.pet_name, p.satiety, p.level,
                    c.threshold, c.enabled
             FROM pet_garden_pet_records p
             LEFT JOIN pet_auto_feed_config c ON c.pet_record_id = p.id
             WHERE p.student_id IN (${placeholders})
             ORDER BY p.id ASC`,
            studentIds
        );

        const pets = petRows.map(row => {
            const typeInfo = row.pet_type ? PET_GARDEN_TYPES.find(t => t.id === row.pet_type) : null;
            return {
                id: row.id,
                petTypeName: typeInfo ? typeInfo.name : (row.pet_type || ''),
                petName: row.pet_name || '',
                satiety: roundPetStat(row.satiety),
                level: row.level || 0,
                threshold: row.threshold !== null && row.threshold !== undefined ? Number(row.threshold) : 80,
                enabled: row.enabled !== null && row.enabled !== undefined ? (row.enabled === 1) : true
            };
        });

        res.json({ success: true, pets });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message || '获取配置失败' });
    }
});

// API：保存自动喂食配置（数组：[{ petId, threshold, enabled }]）
app.post('/api/gameself/auto-feed-config/save', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '').trim();
    const deviceId = String(req.body.deviceId || '').trim() || null;
    const configs = Array.isArray(req.body.configs) ? req.body.configs : [];
    try {
        const account = await validateGameselfAccount({ username, password, deviceId });

        // 查找该用户名对应的所有 student id（可能属于多个班级）
        const students = await dbAll(
            `SELECT id FROM pet_garden_students WHERE linked_username = ?`,
            [username]
        );
        if (!students || students.length === 0) return res.json({ success: true });
        const studentIds = students.map(s => s.id);
        const placeholders = studentIds.map(() => '?').join(',') || 'NULL';

        const now = new Date().toISOString();
        for (const cfg of configs) {
            const petId = Number(cfg.petId);
            if (!Number.isFinite(petId) || petId <= 0) continue;
            // 验证宠物归属（属于当前用户的任意 student 记录）
            const petRow = await dbGet(
                `SELECT id FROM pet_garden_pet_records WHERE id = ? AND student_id IN (${placeholders})`,
                [petId, ...studentIds]
            );
            if (!petRow) continue;

            const threshold = Math.min(100, Math.max(0, Number(cfg.threshold) || 80));
            const enabled = cfg.enabled ? 1 : 0;
            await dbRun(
                `INSERT INTO pet_auto_feed_config (pet_record_id, threshold, enabled, createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(pet_record_id)
                 DO UPDATE SET threshold = excluded.threshold, enabled = excluded.enabled, updatedAt = excluded.updatedAt`,
                [petId, threshold, enabled, now, now]
            );
        }

        res.json({ success: true });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message || '保存配置失败' });
    }
});

async function runAutoFeedJob() {
    const PET_FOOD_SATIETY = FEED_ITEM_CONFIG.pet_food.satietyDelta; // 10

    // 取所有已启用的自动喂食配置，连接宠物和学生信息
    const configs = await dbAll(
        `SELECT c.pet_record_id, c.threshold,
                p.satiety, p.pet_type, p.pet_name,
                s.linked_username, s.linked_type
         FROM pet_auto_feed_config c
         INNER JOIN pet_garden_pet_records p ON p.id = c.pet_record_id
         INNER JOIN pet_garden_students s ON s.id = p.student_id
         WHERE c.enabled = 1
           AND s.linked_username IS NOT NULL
           AND s.linked_type IS NOT NULL
           AND p.pet_type IS NOT NULL`
    );

    if (!configs.length) return;

    // 按用户分组
    const byUser = {};
    for (const cfg of configs) {
        const key = `${cfg.linked_username}|${cfg.linked_type}`;
        if (!byUser[key]) byUser[key] = { username: cfg.linked_username, source: cfg.linked_type, plans: [] };
        const satiety = roundPetStat(cfg.satiety);
        if (satiety < cfg.threshold) {
            const needed = Math.ceil((cfg.threshold - satiety) / PET_FOOD_SATIETY);
            byUser[key].plans.push({ petId: cfg.pet_record_id, petName: cfg.pet_name || '', needed, satiety, threshold: cfg.threshold });
        }
    }

    for (const { username, source, plans } of Object.values(byUser)) {
        if (!plans.length) continue;
        try {
            const inventory = await getGameselfInventoryCounts(username, source);
            // 全部取消条件：库存连每只启用宠物各喂一次都不够
            if (inventory.petFoodCount < plans.length) {
                console.log(`[AutoFeed] ${username}: 主食不足（需至少 ${plans.length}，有 ${inventory.petFoodCount}），跳过`);
                continue;
            }
            let remaining = inventory.petFoodCount;
            for (const plan of plans) {
                const toFeed = Math.min(plan.needed, remaining);
                if (toFeed <= 0) break;
                try {
                    const result = await feedPetInternal(plan.petId, username, source, { pet_food: toFeed, candy: 0 });
                    console.log(`[AutoFeed] ${username} 宠物#${plan.petId}: 喂食 ${toFeed} 主食，饱腹 ${plan.satiety} → ${result.newSatiety}`);
                    remaining -= toFeed;
                    // 写入喂食日志，保留最近10条
                    const logNow = new Date().toISOString();
                    await dbRun(
                        `INSERT INTO pet_auto_feed_log (username, source, pet_id, pet_name, amount, satiety_before, satiety_after, createdAt)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [username, source, plan.petId, plan.petName, toFeed, plan.satiety, result.newSatiety, logNow]
                    );
                    await dbRun(
                        `DELETE FROM pet_auto_feed_log WHERE username = ? AND source = ? AND id NOT IN (
                            SELECT id FROM pet_auto_feed_log WHERE username = ? AND source = ? ORDER BY id DESC LIMIT 10
                        )`,
                        [username, source, username, source]
                    );
                } catch (feedErr) {
                    console.error(`[AutoFeed] ${username} 宠物#${plan.petId} 喂食失败: ${feedErr.message}`);
                }
            }
        } catch (userErr) {
            console.error(`[AutoFeed] 处理用户 ${username} 失败: ${userErr.message}`);
        }
    }
}

// 启动自动喂食调度器（每10分钟）
setInterval(() => {
    runAutoFeedJob().catch(err => console.error('[AutoFeed] 调度器错误:', err.message));
}, 10 * 60 * 1000);
// 服务启动后延迟30秒执行一次，确保数据库初始化完毕
setTimeout(() => {
    runAutoFeedJob().catch(err => console.error('[AutoFeed] 启动时执行错误:', err.message));
}, 30 * 1000);

// =============================================================================
// --- 自动喂食系统结束 ---
// =============================================================================

// --- 课堂激励活动结束 ---

// ===== 专项训练开始 =====
// 新增表：passagequestion 用于专项训练（语法选择 / 完型填空）题库管理
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS passagequestion (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category1 TEXT NOT NULL,
            category2 TEXT NOT NULL,
            seq INTEGER NOT NULL,
            passage_raw TEXT NOT NULL,
            passage_formatted TEXT,
            questions_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(category1, category2, seq)
        )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_passagequestion_cat ON passagequestion(category1, category2, seq)`);
});

// helper: 获取某 (category1, category2) 下最小可用 seq（从1开始回收）
async function getNextAvailablePassageSeq(category1, category2) {
    const rows = await dbAll(`SELECT seq FROM passagequestion WHERE category1 = ? AND category2 = ? ORDER BY seq ASC`, [category1, category2]);
    const used = new Set((rows || []).map(r => Number(r.seq || 0)).filter(n => n >= 1));
    let i = 1;
    while (used.has(i)) i++;
    return i;
}

// helper: 获取全表最小未被占用的 id（从1开始回收），用于给新题目分配可复用的 ID
async function getNextAvailablePassageId() {
    const rows = await dbAll(`SELECT id FROM passagequestion ORDER BY id ASC`, []);
    const used = new Set((rows || []).map(r => Number(r.id || 0)).filter(n => n >= 1));
    let i = 1;
    while (used.has(i)) i++;
    return i;
}

// Create passage
app.post('/api/focus/passage/create', async (req, res) => {
    try {
        const { category1, category2, seq, passage_raw, passage_formatted, questions } = req.body || {};
        if (!category1 || !category2 || !passage_raw) return res.status(400).json({ success: false, error: '缺少 category1/category2 或 passage_raw' });

        const now = nowISO();
        const cat1 = String(category1).trim();
        const cat2 = String(category2).trim();

        let targetSeq = Number(seq) || 0;
        if (targetSeq && targetSeq > 0) {
            const exist = await dbGet(`SELECT id FROM passagequestion WHERE category1 = ? AND category2 = ? AND seq = ? LIMIT 1`, [cat1, cat2, targetSeq]);
            if (exist) return res.status(409).json({ success: false, error: '指定序号已存在' });
        } else {
            targetSeq = await getNextAvailablePassageSeq(cat1, cat2);
        }

        const qjson = typeof questions === 'string' ? questions : JSON.stringify(questions || []);

        // 尝试分配最小未被占用的全局 ID（从1开始），若发生冲突则重试若干次
        const maxAttempts = 6;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const targetId = await getNextAvailablePassageId();
            try {
                const result = await dbRun(
                    `INSERT INTO passagequestion (id, category1, category2, seq, passage_raw, passage_formatted, questions_json, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [targetId, cat1, cat2, targetSeq, passage_raw, passage_formatted || null, qjson, now, now]
                );

                // 插入成功，返回分配的 ID 和序号
                return res.json({ success: true, id: targetId, seq: targetSeq });
            } catch (e) {
                // 如果是唯一索引冲突（例如并发分配到相同 id），则继续重试；否则抛出
                const msg = String(e && e.message ? e.message : '');
                if (msg.includes('UNIQUE') || msg.includes('constraint') || msg.includes('unique')) {
                    // 最后一次重试仍然冲突则返回错误
                    if (attempt === maxAttempts - 1) {
                        return res.status(500).json({ success: false, error: 'ID 分配失败：冲突，保存失败' });
                    }
                    // 继续下一次尝试（短暂让步）
                    await new Promise(r => setTimeout(r, 10));
                    continue;
                }
                throw e;
            }
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || '创建失败' });
    }
});

// Read passage: by id or by category filters
app.get('/api/focus/passage', async (req, res) => {
    try {
        const id = req.query.id || req.query.passageId;
        const category1 = req.query.category1;
        const category2 = req.query.category2;

        if (id) {
            const row = await dbGet(`SELECT * FROM passagequestion WHERE id = ?`, [id]);
            if (!row) return res.status(404).json({ success: false, error: '未找到题目' });
            row.questions = safeParseJson(row.questions_json);
            return res.json({ success: true, passage: row });
        }

        // 列表查询
        let sql = `SELECT id, category1, category2, seq, passage_raw, passage_formatted, questions_json, created_at, updated_at FROM passagequestion`;
        const params = [];
        const where = [];
        if (category1) { where.push('category1 = ?'); params.push(String(category1).trim()); }
        if (category2) { where.push('category2 = ?'); params.push(String(category2).trim()); }
        if (where.length) sql += ' WHERE ' + where.join(' AND ');
        sql += ' ORDER BY category1 ASC, category2 ASC, seq ASC';

        const rows = await dbAll(sql, params);
        const out = (rows || []).map(r => ({ ...r, questions: safeParseJson(r.questions_json) }));
        res.json({ success: true, passages: out });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || '查询失败' });
    }
});

// Browse with pagination for management UI
app.post('/api/focus/passage/browse', async (req, res) => {
    try {
        const { category1, category2, page = 1, pageSize = 50 } = req.body || {};
        const p = Math.max(1, Number(page) || 1);
        const ps = Math.max(1, Math.min(500, Number(pageSize) || 50));
        const where = [];
        const params = [];
        if (category1) { where.push('category1 = ?'); params.push(String(category1).trim()); }
        if (category2) { where.push('category2 = ?'); params.push(String(category2).trim()); }

        const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
        const totalRow = await dbGet(`SELECT COUNT(1) AS cnt FROM passagequestion ${whereSql}`, params);
        const total = totalRow ? Number(totalRow.cnt || 0) : 0;

        const offset = (p - 1) * ps;
        const rows = await dbAll(`SELECT id, category1, category2, seq, passage_raw, passage_formatted, questions_json, created_at, updated_at FROM passagequestion ${whereSql} ORDER BY seq ASC LIMIT ? OFFSET ?`, [...params, ps, offset]);
        const out = (rows || []).map(r => ({ ...r, questions: safeParseJson(r.questions_json) }));
        res.json({ success: true, total, page: p, pageSize: ps, passages: out });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || '浏览失败' });
    }
});

// Update passage (by id or by category+seq)
app.post('/api/focus/passage/update', async (req, res) => {
    try {
        const { id, category1, category2, seq } = req.body || {};
        if (!id && !(category1 && category2 && Number.isFinite(Number(seq)))) return res.status(400).json({ success: false, error: '需要 id 或 (category1, category2, seq) 定位要更新的记录' });

        // 找到目标记录
        let target = null;
        if (id) target = await dbGet(`SELECT * FROM passagequestion WHERE id = ?`, [id]);
        else target = await dbGet(`SELECT * FROM passagequestion WHERE category1 = ? AND category2 = ? AND seq = ? LIMIT 1`, [String(category1).trim(), String(category2).trim(), Number(seq)]);
        if (!target) return res.status(404).json({ success: false, error: '未找到要更新的记录' });

        // 准备更新字段
        const updates = [];
        const params = [];
        const now = nowISO();
        const up = req.body || {};

        if (up.category1 !== undefined) { updates.push('category1 = ?'); params.push(String(up.category1).trim()); }
        if (up.category2 !== undefined) { updates.push('category2 = ?'); params.push(String(up.category2).trim()); }
        if (up.seq !== undefined) {
            const newSeq = Number(up.seq) || 0;
            if (newSeq <= 0) return res.status(400).json({ success: false, error: 'seq 必须为正整数' });
            // 检查冲突：在目标位置（可能更改 category）是否已有同 seq 的其他记录
            const newCat1 = up.category1 !== undefined ? String(up.category1).trim() : target.category1;
            const newCat2 = up.category2 !== undefined ? String(up.category2).trim() : target.category2;
            const conflict = await dbGet(`SELECT id FROM passagequestion WHERE category1 = ? AND category2 = ? AND seq = ? AND id != ? LIMIT 1`, [newCat1, newCat2, newSeq, target.id]);
            if (conflict) return res.status(409).json({ success: false, error: '目标序号与现有记录冲突' });
            updates.push('seq = ?'); params.push(newSeq);
        }
        if (up.passage_raw !== undefined) { updates.push('passage_raw = ?'); params.push(up.passage_raw); }
        if (up.passage_formatted !== undefined) { updates.push('passage_formatted = ?'); params.push(up.passage_formatted); }
        if (up.questions !== undefined) { updates.push('questions_json = ?'); params.push(typeof up.questions === 'string' ? up.questions : JSON.stringify(up.questions || [])); }

        if (updates.length === 0) return res.json({ success: true, message: '无更新字段' });
        updates.push('updated_at = ?'); params.push(now);
        params.push(target.id);

        await dbRun(`UPDATE passagequestion SET ${updates.join(', ')} WHERE id = ?`, params);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || '更新失败' });
    }
});

// Delete passage (by id or by category+seq)
app.post('/api/focus/passage/delete', async (req, res) => {
    try {
        const { id, category1, category2, seq } = req.body || {};
        if (id) {
            const result = await dbRun(`DELETE FROM passagequestion WHERE id = ?`, [id]);
            return res.json({ success: true, deleted: result.changes || 0 });
        }
        if (category1 && category2 && Number.isFinite(Number(seq))) {
            const result = await dbRun(`DELETE FROM passagequestion WHERE category1 = ? AND category2 = ? AND seq = ?`, [String(category1).trim(), String(category2).trim(), Number(seq)]);
            return res.json({ success: true, deleted: result.changes || 0 });
        }
        return res.status(400).json({ success: false, error: '需要 id 或 (category1, category2, seq) 指定删除目标' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || '删除失败' });
    }
});

// 获取下一个可用 seq
app.get('/api/focus/passage/next-seq', async (req, res) => {
    try {
        const { category1, category2 } = req.query || {};
        if (!category1 || !category2) return res.status(400).json({ success: false, error: '缺少 category1 或 category2' });
        const next = await getNextAvailablePassageSeq(String(category1).trim(), String(category2).trim());
        res.json({ success: true, nextSeq: next });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || '获取失败' });
    }
});

// ===== 专项训练结果 =====
