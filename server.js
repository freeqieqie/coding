=================
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
