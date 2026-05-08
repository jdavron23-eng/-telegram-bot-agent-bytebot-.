require('dotenv').config();
const { Telegraf, session, Scenes, Markup } = require('telegraf');
const { Document, Packer, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun } = require('docx');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');
const fs = require('fs');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');
const pptxgen = require('pptxgenjs');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;
const CARD_NUMBER = process.env.CARD_NUMBER || '8600 0000 0000 0000';
const CARD_OWNER = process.env.CARD_OWNER || 'Admin';
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const GROQ_API_KEY = process.env.GROQ_API_KEY || null;

// File Extraction Helper
async function extractTextFromBuffer(buffer, mimeType, filename) {
    if (mimeType === 'application/pdf') {
        const data = await pdfParse(buffer);
        return data.text;
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const data = await mammoth.extractRawText({ buffer });
        return data.value;
    } else if (filename.endsWith('.txt')) {
        return buffer.toString('utf8');
    }
    return null;
}

// Progress Bar Helper
const getProgressBar = (percent) => {
    const total = 10;
    const progress = Math.round((percent / 100) * total);
    const empty = total - progress;
    
    // Vizual effektlar uchun turli rangdagi bloklar
    const symbols = ['🟦', '🟩', '🟨', '🟧', '🟥'];
    const symbol = symbols[Math.floor(percent / 21)] || '🟦';
    
    return symbol.repeat(progress) + '⬜'.repeat(empty) + ` ${percent}%`;
};

async function updateProgress(userId, messageId, percent, status) {
    if (!messageId) return;
    const bar = getProgressBar(percent);
    const anim = ['⌛', '⏳', '🔄', '✨'][Math.floor(Date.now() / 1000) % 4];
    const text = `<b>${anim} Jarayon: ${percent}%</b>\n\n${bar}\n\n💠 ${status}`;
    await bot.telegram.editMessageText(userId, messageId, null, text, { parse_mode: 'HTML' }).catch(() => {});
}

// HTML escaping helper
const esc = (str) => (str || '').toString().replace(/<[^>]*>?/gm, '').replace(/[&"']/g, m => ({'&':'&amp;', '"':'&quot;', "'":'&#39;'}[m]));

// Navigatsiya tugmalari
const wizardButtons = Markup.keyboard([
    ["⬅️ Orqaga", "❌ Bekor qilish"]
]).resize();

// PPTX Temalari
const PPTX_THEMES = {
    MODERN: {
        bg: '2c3e50',
        titleColor: '3498db',
        textColor: 'ecf0f1',
        accent: 'e74c3c',
        font: 'Arial'
    },
    ACADEMIC: {
        bg: 'ffffff',
        titleColor: '2c3e50',
        textColor: '34495e',
        accent: '2980b9',
        font: 'Times New Roman'
    },
    CREATIVE: {
        bg: 'f3f4f6',
        titleColor: '6366f1',
        textColor: '1f2937',
        accent: 'f59e0b',
        font: 'Verdana'
    },
    ECO_GREEN: {
        bg: 'f0fdf4',
        titleColor: '15803d',
        textColor: '14532d',
        accent: '86efac',
        font: 'Segoe UI'
    },
    ROYAL_GOLD: {
        bg: '1c1917',
        titleColor: 'facc15',
        textColor: 'fafaf9',
        accent: 'a8a29e',
        font: 'Georgia'
    },
    TECH_PURPLE: {
        bg: '0f172a',
        titleColor: 'c084fc',
        textColor: 'f8fafc',
        accent: '38bdf8',
        font: 'Consolas'
    }
};

// Navigatsiyani boshqarish funksiyasi
async function checkNavigation(ctx) {
    if (!ctx.message || !ctx.message.text) return false;
    if (ctx.message.text === "❌ Bekor qilish") {
        await ctx.reply("❌ Amal bekor qilindi.", getMainMenu());
        await ctx.scene.leave();
        return true;
    }
    if (ctx.message.text === "⬅️ Orqaga") {
        if (ctx.wizard.cursor > 0) {
            ctx.wizard.back(); // Orqaga qaytish
            // Avvalgi qadamni qaytadan chaqirish uchun:
            const prevStep = ctx.wizard.steps[ctx.wizard.cursor];
            return prevStep(ctx);
        } else {
            await ctx.reply("Siz birinchi qadamsiz. Bekor qilish uchun '❌ Bekor qilish' tugmasini bosing.");
            return true;
        }
    }
    return false;
}

// Caches & Stats
const pendingPayments = new Map();
const ordersCache = new Map();
const pendingSendTargets = new Map();
let uniqueUsers = new Set();
let totalOrders = 0;

// Flashcard xotirasi
const flashcardStorage = new Map();

// Doimiy xotira fayllari
const QUIZ_FILE = path.join(__dirname, 'quizzes.json');
const TEAM_QUIZ_FILE = path.join(__dirname, 'team_quizzes.json');
const TEACHER_SUBS_FILE = path.join(__dirname, 'teacher_subs.json');
const TEAM_CODES_FILE = path.join(__dirname, 'team_codes.json');

// Jamoaviy test xotirasi
let teamQuizStorage = new Map();
let teacherSubs = new Map();
let teamCodes = new Map();

// URL olish yordamchi funksiyasi
function getWebAppUrl() {
    const url = process.env.WEB_APP_URL || '';
    return url.replace(/\/$/, ''); // Oxiridagi '/' ni olib tashlaymiz
}

// Ma'lumotlarni yuklash funksiyasi
async function loadPersistentData() {
    try {
        if (fs.existsSync(TEAM_QUIZ_FILE)) {
            const data = JSON.parse(await fs.promises.readFile(TEAM_QUIZ_FILE, 'utf8'));
            teamQuizStorage = new Map(Object.entries(data));
        }
        if (fs.existsSync(TEACHER_SUBS_FILE)) {
            const data = JSON.parse(await fs.promises.readFile(TEACHER_SUBS_FILE, 'utf8'));
            teacherSubs = new Map(Object.entries(data).map(([k, v]) => [parseInt(k), v]));
        }
        if (fs.existsSync(TEAM_CODES_FILE)) {
            const data = JSON.parse(await fs.promises.readFile(TEAM_CODES_FILE, 'utf8'));
            teamCodes = new Map(Object.entries(data));
        }
    } catch (e) {
        console.error("[DATA] Yuklashda xato:", e);
    }
}

async function savePersistentData() {
    try {
        await fs.promises.writeFile(TEAM_QUIZ_FILE, JSON.stringify(Object.fromEntries(teamQuizStorage), null, 2));
        await fs.promises.writeFile(TEACHER_SUBS_FILE, JSON.stringify(Object.fromEntries(teacherSubs), null, 2));
        await fs.promises.writeFile(TEAM_CODES_FILE, JSON.stringify(Object.fromEntries(teamCodes), null, 2));
    } catch (e) {
        console.error("[DATA] Saqlashda xato:", e);
    }
}

// Eskirgan ma'lumotlarni tozalash (har soatda)
setInterval(() => {
    const now = Date.now();
    let deletedCount = 0;

    // Team Quizzes tozalash
    for (const [teamId, quiz] of teamQuizStorage.entries()) {
        if (quiz.expiryTime < now) {
            teamQuizStorage.delete(teamId);
            // Koddni ham o'chirish
            for (const [code, id] of teamCodes.entries()) {
                if (id === teamId) teamCodes.delete(code);
            }
            deletedCount++;
        }
    }
    
    if (deletedCount > 0) {
        console.log(`[CLEANUP] ${deletedCount} ta eskirgan jamoaviy test o'chirildi.`);
        savePersistentData().catch(() => {});
    }
}, 3600000);

// Tunnel o'zgarganda barcha faol dashboardlarni yangilash
async function updateAllActiveDashboards() {
    const now = Date.now();
    const url = getWebAppUrl();
    if (!url) return;

    console.log(`[DASHBOARD] Barcha faol dashboardlarni yangilash boshlandi...`);
    
    for (const [teamId, quiz] of teamQuizStorage.entries()) {
        if (quiz.expiryTime > now && quiz.messageId) {
            const link = `${url}/?teamId=${teamId}&v=${Date.now()}`;
            const remainingMs = quiz.expiryTime - now;
            const minutes = Math.max(0, Math.floor(remainingMs / 60000));
            const seconds = Math.max(0, Math.floor((remainingMs % 60000) / 1000));
            const timerStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
            
            const clockEmojis = ['🕛', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚'];
            const clock = clockEmojis[Math.floor(Date.now() / 5000) % clockEmojis.length];

            let list = (quiz.submissions || []).slice(-15).map((s) => {
                const percent = Math.round((s.score / s.total) * 100);
                let uname = (s.username || "").toString().replace(/^@+/, '');
                const username = uname ? `(@${esc(uname)})` : "";
                return `✅ <b>${esc(s.name)}</b> ${username} — <b>${s.score}/${s.total}</b> (${percent}%)`;
            }).join('\n');

            let msgText = `📊 <b>JAMOAVIY TEST MONITORING</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📚 Mavzu: <b>${esc(quiz.topic)}</b>\n` +
                `🔑 Kod: <code>${quiz.code}</code>\n` +
                `🎯 Topshirdi: <b>${quiz.submissions.length}/${quiz.expectedStudents}</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `🔗 <b>YANGI HAVOLA:</b>\n${link}\n\n` +
                `📝 <b>SO'NGGI NATIJALAR:</b>\n` +
                `${list || '<i>Hali natijalar yo\'q...</i>'}\n\n` +
                `✨ <i>Tunnel o'zgardi, havola yangilandi.</i>`;

            await bot.telegram.editMessageText(quiz.teacherId, quiz.messageId, null, msgText, { 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: `${clock} ${timerStr} | ➕ Vaqt uzaytirish`, callback_data: "extend_time" }]] }
            }).catch(() => {});
        }
    }
}

// Botni ishga tushirish va ma'lumotlarni yuklash (Async)
(async () => {
    await loadPersistentData();

    // Testlarni xotiraga yuklash
    try {
        if (fs.existsSync(QUIZ_FILE)) {
            const fileData = await fs.promises.readFile(QUIZ_FILE, 'utf8');
            const jsonData = JSON.parse(fileData);
            quizStorage = new Map(Object.entries(jsonData).map(([k, v]) => {
                const value = Array.isArray(v) ? { topic: 'Mavzu ko\'rsatilmadi', questions: v } : v;
                return [parseInt(k), value];
            }));
            console.log(`[DATA] ${quizStorage.size} ta test fayldan yuklandi.`);
        }
    } catch (err) {
        console.error("[DATA] Quizzes yuklashda xatolik:", err);
    }

    // Taqdimot limitlari
    try {
        if (fs.existsSync(LIMITS_FILE)) {
            const fileData = await fs.promises.readFile(LIMITS_FILE, 'utf8');
            const jsonData = JSON.parse(fileData);
            taqdimotLimits = new Map(Object.entries(jsonData).map(([k, v]) => [parseInt(k), v]));
            console.log(`[DATA] ${taqdimotLimits.size} ta foydalanuvchi limitlari yuklandi.`);
        }
    } catch (err) {
        console.error("[DATA] Limitlarni yuklashda xatolik:", err);
    }
})();

// Testlarni xotiraga yuklash yoki yangi Map yaratish
let quizStorage = new Map();

// Taqdimot limitlari xotirasi
const LIMITS_FILE = path.join(__dirname, 'taqdimot_limits.json');
let taqdimotLimits = new Map();

// Testlarni faylga saqlash funksiyasi
async function saveQuizzes() {
    try {
        const obj = Object.fromEntries(quizStorage);
        await fs.promises.writeFile(QUIZ_FILE, JSON.stringify(obj, null, 2));
    } catch (err) {
        console.error("[DATA] Saqlashda xatolik:", err);
    }
}

async function saveTaqdimotLimits() {
    try {
        const obj = Object.fromEntries(taqdimotLimits);
        await fs.promises.writeFile(LIMITS_FILE, JSON.stringify(obj, null, 2));
    } catch (err) {
        console.error("[DATA] Limitlarni saqlashda xatolik:", err);
    }
}

// Foydalanuvchilarni sanash uchun middleware + admin /send interceptor
bot.use(async (ctx, next) => {
    if (ctx.from) uniqueUsers.add(ctx.from.id);
    
    // Admin fayl yuborish — scene'dan mustaqil ishlaydi
    if (ctx.message && ctx.message.document && 
        ctx.from.id.toString() === ADMIN_ID && 
        pendingSendTargets.has(ctx.from.id)) {
        const targetUserId = pendingSendTargets.get(ctx.from.id);
        pendingSendTargets.delete(ctx.from.id);
        const fileId = ctx.message.document.file_id;
        const fileName = ctx.message.document.file_name || 'Fayl';
        try {
            await bot.telegram.sendDocument(targetUserId, fileId, {
                caption: `🎨 <b>Sizning buyurtmangiz tayyor!</b>\n\n📎 Fayl: ${fileName}\n\nBotimizdan foydalanganingiz uchun rahmat! 🙏`,
                parse_mode: 'HTML'
            });
            await bot.telegram.sendMessage(targetUserId, "Yana nima qilishni xohlaysiz?", { ...getMainMenu() });
            ctx.reply(`✅ Fayl foydalanuvchi <code>${targetUserId}</code> ga muvaffaqiyatli yuborildi!`, { parse_mode: 'HTML', ...getMainMenu() });
        } catch (e) {
            ctx.reply(`❌ Yuborishda xatolik: ${e.message}`);
        }
        return; // scene middleware'ga bermaydi
    }
    
    return next();
});

bot.catch((err, ctx) => {
    console.error(`Xato yuz berdi (${ctx.updateType}):`, err);
});

// Flashcard matnidan kartochkalar arrayini ajratish
function parseFlashcardText(text) {
    const cards = [];
    // Split by card markers
    const cardBlocks = text.split(/(?:📝\s*\*\*Kartochka|Kartochka)\s*#?\d+\*?\*?/i).filter(b => b.trim().length > 20);
    
    for (const block of cardBlocks) {
        const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let question = '', answer = '', hint = '';
        
        for (const line of lines) {
            const cleanLine = line.replace(/^[❓✅💡]\s*/, '').replace(/^\*\*[^*]+\*\*\s*:?\s*/, '');
            if (/savol|❓/i.test(line)) {
                question = cleanLine || lines[lines.indexOf(line) + 1]?.trim() || '';
            } else if (/javob|✅/i.test(line)) {
                answer = cleanLine || lines[lines.indexOf(line) + 1]?.trim() || '';
            } else if (/eslatma|💡|hint/i.test(line)) {
                hint = cleanLine || '';
            }
        }
        
        // Fallback: agar pattern topilmasa, qatorlardan olish
        if (!question && lines.length >= 2) {
            question = lines[0].replace(/^[❓✅💡*#\d.)\-]+\s*/, '');
            answer = lines[1].replace(/^[❓✅💡*#\d.)\-]+\s*/, '');
            hint = lines[2] ? lines[2].replace(/^[❓✅💡*#\d.)\-]+\s*/, '') : '';
        }
        
        if (question && answer) {
            cards.push({ question, answer, hint });
        }
    }
    
    return cards.length > 0 ? cards : null;
}

// Tasvirlarni base64 formatiga o'tkazish (Kengaytirilgan mantiq)
async function getImageBase64(keyword, retries = 1) {
    const https = require('https');
    const agent = new https.Agent({ rejectUnauthorized: false });
    
    // Kalit so'zni tozalash
    const cleanKeyword = encodeURIComponent((keyword || 'education').replace(/[^a-zA-Z0-9 ]/g, '').trim());

    const sources = [
        `https://image.pollinations.ai/prompt/${cleanKeyword}?width=1024&height=768&nologo=true&seed=${Date.now()}`,
        `https://loremflickr.com/1024/768/${cleanKeyword}`,
        `https://picsum.photos/1024/768` // Eng oxirgi variant
    ];

    for (let src of sources) {
        for (let i = 0; i <= retries; i++) {
            try {
                const response = await axios.get(src, { 
                    responseType: 'arraybuffer', 
                    timeout: 8000,
                    httpsAgent: agent,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });
                
                if (response.data && response.data.length > 1000) { // Haqiqiy rasm ekanligini tekshirish
                    const base64 = Buffer.from(response.data).toString('base64');
                    return `data:image/png;base64,${base64}`;
                }
            } catch (e) {
                if (i === retries) continue; 
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
    return null;
}

// Taqdimot matnidan slaydlar ajratish
function parsePresentationText(text) {
    if (!text) return null;
    const slides = [];
    const blocks = text.split(/SLIDE\s*\d*\s*:/i).filter(b => b.trim().length > 10);

    for (const block of blocks) {
        const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length < 2) continue;

        let title = lines[0].replace(/[*#]/g, '').trim();
        let keyword = 'abstract';
        let notes = '';
        const content = [];

        let currentSection = 'CONTENT';
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            const upperLine = line.toUpperCase();
            
            if (upperLine.startsWith('KEYWORD:')) {
                keyword = line.split(':')[1]?.trim() || 'abstract';
            } else if (upperLine.startsWith('NOTES:')) {
                notes = line.replace(/NOTES:/i, '').trim();
                currentSection = 'NOTES';
            } else if (upperLine.startsWith('CONTENT:')) {
                currentSection = 'CONTENT';
            } else {
                if (currentSection === 'CONTENT') {
                    if (line.startsWith('-') || line.startsWith('*') || /^\d+\./.test(line)) {
                        content.push(line.replace(/^[-*\d.]+\s*/, '').trim());
                    } else if (line.length > 10) {
                        content.push(line);
                    }
                } else if (currentSection === 'NOTES') {
                    notes += ' ' + line;
                }
            }
        }
        if (content.length > 0) {
            slides.push({ title, content, keyword, notes: notes.trim() });
        }
    }
    return slides.length > 0 ? slides : null;
}

// Test matnidan quiz obyektini ajratish
function parseQuizText(text) {
    const questions = [];
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    let currentQuestion = null;
    
    const keyMatch = text.match(/JAVOBLAR KALITI[:\s]*(.*)/is) || text.match(/KALIT[:\s]*(.*)/is) || text.match(/JAVOBLAR[:\s]*(.*)/is);
    const answerKeysStr = keyMatch ? keyMatch[1] : "";
    const answerKeys = {};
    
    // Pattern 1: 1-A, 1.A, 1:A (bolding bilan ham)
    const keyRegex1 = /(?:\*\*)?(\d+)(?:\*\*)?[-.:\s]+([A-D])/gi;
    let m;
    while ((m = keyRegex1.exec(answerKeysStr)) !== null) {
        answerKeys[m[1]] = m[2].toUpperCase();
    }
    
    // Pattern 2: (To'g'ri javob: A) style inside questions if not found in key block
    // We'll handle this inside the line loop if needed.

    for (let line of lines) {
        // Savolni aniqlash: "1. ", "1)", "1-savol" kabi boshlanishlarni tutib olish (bolding bilan ham)
        const qMatch = line.match(/^(?:Savol\s*)?(?:\*\*)?(\d+)(?:\*\*)?[.)\-\s]+(.+)/i);
        if (qMatch) {
            if (currentQuestion && currentQuestion.options.length >= 2) {
                questions.push(currentQuestion);
            }
            currentQuestion = {
                id: qMatch[1],
                question: qMatch[2].replace(/\*/g, '').trim(),
                options: [],
                correct: 0
            };
        } 
        // Variantlarni aniqlash: "A)", "A.", "a)" kabi boshlanishlarni tutib olish
        else if (/^\*?(?:\*\*)?([A-D])(?:\*\*)?[.)\-\s]+(.+)/i.test(line)) {
            const optMatch = line.match(/^\*?(?:\*\*)?([A-D])(?:\*\*)?[.)\-\s]+(.+)/i);
            if (currentQuestion) {
                let optText = optMatch[2].trim();
                let isCorrect = line.trim().startsWith('*') || optText.startsWith('*') || optText.endsWith('*');
                currentQuestion.options.push(optText.replace(/\*/g, '').trim());
                if (isCorrect) {
                    answerKeys[currentQuestion.id] = optMatch[1].toUpperCase();
                }
            }
        }
        // Qator ichida "Javob: A" yoki "To'g'ri javob: B" kabi ko'rsatmalar bo'lsa
        else if (/(?:Javob|To'g'ri|Kalit)[^a-zA-Z]*([A-D])\b/i.test(line)) {
            if (currentQuestion) {
                const match = line.match(/(?:Javob|To'g'ri|Kalit)[^a-zA-Z]*([A-D])\b/i);
                answerKeys[currentQuestion.id] = match[1].toUpperCase();
            }
        }
    }
    
    if (currentQuestion && currentQuestion.options.length >= 2) {
        questions.push(currentQuestion);
    }

    questions.forEach((q, idx) => {
        const qNum = q.id || (idx + 1).toString();
        let keyLetter = answerKeys[qNum];
        
        // If not found in answerKeys, try to find it in the question text or options (e.g. bolded or marked)
        if (!keyLetter) {
            // fallback: check if any option is marked as correct by the AI (e.g. with asterisk)
            // but our current logic removes asterisks.
        }

        if (keyLetter) {
            const letterIdx = keyLetter.charCodeAt(0) - 65;
            q.correct = letterIdx >= 0 && letterIdx < q.options.length ? letterIdx : 0;
        } else {
            // Last resort: if no key found, randomly pick one to avoid all being 'A'
            q.correct = Math.floor(Math.random() * q.options.length);
        }
    });

    // Agar parser hech nima topa olmasa (AI formati buzilgan bo'lsa), xatolik o'rniga namuna ko'rsatamiz
    if (questions.length === 0) {
        questions.push({
            question: "Kechirasiz, AI tuzgan test formatini dastur taniy olmadi. Iltimos botga /start berib, qayta urinib ko'ring.",
            options: ["Tushunarli", "Boshqa mavzu tanlayman", "AI formatini to'g'irlayman", "Qayta urinish"],
            correct: 0
        });
    }

    return questions;
}

// Dars rejasi yaratish Wizard
const darsRejasiWizard = new Scenes.WizardScene(
    'darsRejasiWizard',
    (ctx) => {
        ctx.scene.session.order = { service: 'Dars rejasi' };
        ctx.reply("📋 Dars rejasi yaratish uchun fan nomini kiriting:\n(Masalan: Matematika, Fizika, Ona tili)", wizardButtons);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, fan nomini kiriting:");
        ctx.scene.session.order.subject = ctx.message.text;
        ctx.reply("Dars mavzusini kiriting:", wizardButtons);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, mavzuni kiriting:");
        ctx.scene.session.order.topic = ctx.message.text;
        ctx.reply("Sinf/kurs darajasini tanlang:", Markup.keyboard([
            ["1-4 sinf (Boshlang'ich)", "5-9 sinf"],
            ["10-11 sinf", "Oliy ta'lim"],
            ["⬅️ Orqaga", "❌ Bekor qilish"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, darajani tanlang:");
        ctx.scene.session.order.grade = ctx.message.text;
        ctx.reply("Dars davomiyligi:", Markup.keyboard([
            ["40 daqiqa", "80 daqiqa (juft dars)"],
            ["⬅️ Orqaga", "❌ Bekor qilish"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, davomiylikni tanlang:");
        ctx.scene.session.order.duration = ctx.message.text;
        ctx.reply("Qaysi tilda yozilsin?", Markup.keyboard([
            ["🇺🇿 O'zbek (lotin)", "🇷🇺 Rus"],
            ["🇬🇧 Ingliz"],
            ["⬅️ Orqaga", "❌ Bekor qilish"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, tilni tanlang:");
        ctx.scene.session.order.language = ctx.message.text;
        const order = ctx.scene.session.order;
        const cachedOrder = { ...order, userId: ctx.from.id, username: ctx.from.username || "yo'q" };
        ordersCache.set(ctx.from.id, cachedOrder);
        await ctx.reply("✅ <b>Dars rejasi tayyorlanmoqda!</b>\n\nIltimos, 15-20 soniya kuting...", { parse_mode: 'HTML', ...Markup.removeKeyboard() });
        processAIGeneration(ctx.from.id, cachedOrder);
        return ctx.scene.leave();
    }
);

// Uy vazifasi yaratish Wizard
const uyVazifasiWizard = new Scenes.WizardScene(
    'uyVazifasiWizard',
    (ctx) => {
        ctx.scene.session.order = { service: 'Uy vazifasi' };
        ctx.reply("📖 Uy vazifasi yaratish uchun fan nomini kiriting:\n(Masalan: Matematika, Ingliz tili, Biologiya)", wizardButtons);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, fan nomini kiriting:");
        ctx.scene.session.order.subject = ctx.message.text;
        ctx.reply("Mavzuni kiriting:", wizardButtons);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, mavzuni kiriting:");
        ctx.scene.session.order.topic = ctx.message.text;
        ctx.reply("Sinf/kurs darajasini tanlang:", Markup.keyboard([
            ["1-4 sinf (Boshlang'ich)", "5-9 sinf"],
            ["10-11 sinf", "Oliy ta'lim"],
            ["⬅️ Orqaga", "❌ Bekor qilish"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, darajani tanlang:");
        ctx.scene.session.order.grade = ctx.message.text;
        ctx.reply("Topshiriqlar soni:", Markup.keyboard([
            ["5 ta", "10 ta"],
            ["15 ta", "20 ta"],
            ["⬅️ Orqaga", "❌ Bekor qilish"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        const count = parseInt(ctx.message.text);
        if (isNaN(count)) return ctx.reply("⚠️ Iltimos, faqat son kiriting:");
        
        ctx.scene.session.order.count = count;
        ctx.scene.session.order.pages = ctx.message.text;
        ctx.reply("Qiyinlik darajasi:", Markup.keyboard([
            ["Oson", "O'rtacha", "Qiyin"],
            ["⬅️ Orqaga", "❌ Bekor qilish"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, qiyinlikni tanlang:");
        ctx.scene.session.order.difficulty = ctx.message.text;
        ctx.reply("Qaysi tilda yozilsin?", Markup.keyboard([
            ["🇺🇿 O'zbek (lotin)", "🇷🇺 Rus"],
            ["🇬🇧 Ingliz"],
            ["⬅️ Orqaga", "❌ Bekor qilish"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, tilni tanlang:");
        ctx.scene.session.order.language = ctx.message.text;
        const order = ctx.scene.session.order;
        const cachedOrder = { ...order, userId: ctx.from.id, username: ctx.from.username || "yo'q" };
        ordersCache.set(ctx.from.id, cachedOrder);
        await ctx.reply("✅ <b>Uy vazifasi tayyorlanmoqda!</b>\n\nIltimos, 15-20 soniya kuting...", { parse_mode: 'HTML', ...Markup.removeKeyboard() });
        processAIGeneration(ctx.from.id, cachedOrder);
        return ctx.scene.leave();
    }
);

// Mavzu tushuntirish Scene
const mavzuScene = new Scenes.BaseScene('mavzuScene');

mavzuScene.enter(async (ctx) => {
    await ctx.reply("💡 <b>Mavzu tushuntirish rejimi</b>\n\nIstalgan mavzuni yozing — AI sizga batafsil, sodda tilda tushuntirib beradi.\n\nChiqish uchun /cancel bosing.", {
        parse_mode: 'HTML',
        ...Markup.removeKeyboard()
    });
});

mavzuScene.on('text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    try {
        const typing = await ctx.reply("⏳ Javob tayyorlanmoqda...");
        const systemPrompt = "Siz tajribali o'qituvchisiz. Berilgan mavzuni o'quvchilarga tushunarli, sodda va qiziqarli tilda tushuntiring. Misollar, qiyoslashlar va hayotiy holatlar keltiring. Javobni 300-500 so'z atrofida bering.";
        const aiResponse = await callAI(text, systemPrompt);
        await ctx.telegram.deleteMessage(ctx.chat.id, typing.message_id).catch(() => {});
        await ctx.reply(aiResponse, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔄 Boshqa mavzu", callback_data: "another_topic" }],
                    [{ text: "❌ Chiqish", callback_data: "exit_mavzu" }]
                ]
            }
        });
    } catch (e) {
        ctx.reply("⚠️ Xatolik yuz berdi. Qayta urinib ko'ring.");
    }
});

mavzuScene.action('another_topic', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.reply("Yangi mavzuni yozing:");
});

mavzuScene.action('exit_mavzu', (ctx) => {
    ctx.answerCbQuery();
    ctx.reply("Mavzu tushuntirish rejimi tugatildi.", getMainMenu());
    return ctx.scene.leave();
});

mavzuScene.command('cancel', (ctx) => {
    ctx.reply("Mavzu tushuntirish rejimi tugatildi.", getMainMenu());
    return ctx.scene.leave();
});



const testWizard = new Scenes.WizardScene(
    'testWizard',
    (ctx) => {
        ctx.scene.session.order = { service: 'Test yaratish' };
        ctx.reply("📝 **Test yaratish rejimiga xush kelibsiz!**\n\nSavollar manbasini tanlang:", Markup.inlineKeyboard([
            [Markup.button.callback("✍️ Mavzu yozish", "source_topic")],
            [Markup.button.callback("📂 Fayl yuklash (PDF/DOCX)", "source_file")]
        ]));
        return ctx.wizard.next();
    },
    (ctx) => {
        ctx.scene.session.order = { service: 'Test yaratish' };
        ctx.reply("📝 **Test yaratish rejimiga xush kelibsiz!**\n\nSavollar manbasini tanlang:", Markup.inlineKeyboard([
            [Markup.button.callback("✍️ Mavzu yozish", "source_topic")],
            [Markup.button.callback("📂 Fayl yuklash (PDF/DOCX)", "source_file")],
            [Markup.button.callback("❌ Bekor qilish", "cancel_wizard")]
        ]));
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.callbackQuery) {
            await ctx.answerCbQuery();
            const source = ctx.callbackQuery.data;
            if (source === 'cancel_wizard') {
                ctx.reply("❌ Bekor qilindi.", getMainMenu());
                return ctx.scene.leave();
            }
            if (source === 'source_topic') {
                ctx.reply("Mavzu nomini yozing:", wizardButtons);
                ctx.scene.session.sourceType = 'topic';
            } else {
                ctx.reply("📁 Marhamat, faylni (PDF, DOCX yoki TXT) yuboring:", wizardButtons);
                ctx.scene.session.sourceType = 'file';
            }
            return;
        }
        
        if (await checkNavigation(ctx)) return;

        if (ctx.scene.session.sourceType === 'file' && ctx.message.document) {
            const doc = ctx.message.document;
            try {
                const fileLink = await ctx.telegram.getFileLink(doc.file_id);
                const fileUrl = fileLink.href || fileLink.toString();
                
                const prog = await ctx.reply("⏳ Fayl yuklanmoqda...");
                
                const response = await fetch(fileUrl);
                if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);
                
                await ctx.telegram.editMessageText(ctx.chat.id, prog.message_id, null, "🧐 Fayl tahlil qilinmoqda (matn ajratib olinmoqda)...");
                
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                const text = await extractTextFromBuffer(buffer, doc.mime_type, doc.file_name);
                
                if (text && text.trim().length > 10) {
                    ctx.scene.session.order.contextText = text.substring(0, 10000); // Token limit
                    ctx.scene.session.order.topic = `Fayl: ${doc.file_name}`;
                    await ctx.telegram.editMessageText(ctx.chat.id, prog.message_id, null, `✅ Fayl muvaffaqiyatli o'qildi (${Math.round(text.length / 1024)} KB).`);
                } else {
                    return ctx.reply("❌ Fayldan matnni ajratib bo'lmadi. Iltimos, boshqa fayl yuboring:");
                }
            } catch (e) {
                console.error("File Error:", e);
                return ctx.reply(`❌ Xatolik: ${e.message}. Iltimos, qayta urinib ko'ring.`);
            }
        } else if (ctx.scene.session.sourceType === 'topic' && ctx.message.text) {
            ctx.scene.session.order.topic = ctx.message.text;
        } else {
            return ctx.reply("Iltimos, tanlovingizga mos ma'lumotni yuboring:");
        }

        ctx.reply("🌐 Testlar qaysi tilda bo'lsin?", Markup.keyboard([
            ["🇺🇿 O'zbek (lotin)", "🇷🇺 Rus"],
            ["🇬🇧 Ingliz", "Ўзбек (кирилл)"],
            ["⬅️ Orqaga", "❌ Bekor qilish"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, tilni tanlang:");
        ctx.scene.session.order.language = ctx.message.text;
        ctx.reply("Nechta test savoli yaratilsin?", Markup.keyboard([
            ["10 ta", "20 ta"],
            ["30 ta", "50 ta"],
            ["⬅️ Orqaga", "❌ Bekor qilish"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        const count = parseInt(ctx.message.text);
        if (isNaN(count)) return ctx.reply("⚠️ Iltimos, faqat son kiriting (masalan: 10):");
        
        ctx.scene.session.order.pages = ctx.message.text; 
        ctx.scene.session.order.count = count;

        ctx.reply("Test murakkablik darajasini tanlang:", Markup.keyboard([
            ["Sodda", "O'rtacha", "Kuchli"],
            ["⬅️ Orqaga", "❌ Bekor qilish"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, darajani tanlang:");
        ctx.scene.session.order.difficulty = ctx.message.text;

        const countStr = ctx.scene.session.order.pages;

        let price = "0";
        ctx.scene.session.order.price = price;

        const order = ctx.scene.session.order;
        const cachedOrder = {
            ...order,
            userId: ctx.from.id,
            username: ctx.from.username || "yo'q",
            name: ctx.from.first_name || 'Mijoz',
            phone: 'Suhbat orqali'
        };
        ordersCache.set(ctx.from.id, cachedOrder);

        await ctx.reply(
            `✅ <b>Buyurtma qabul qilindi!</b>\n\n` +
            `Bot hozir test savollarini bepul yaratishni boshlaydi. Iltimos kuting...`,
            { parse_mode: 'HTML', ...Markup.removeKeyboard() }
        );
        processAIGeneration(ctx.from.id, cachedOrder);
        return ctx.scene.leave();
    }
);

// Taqdimot yaratish Wizard (Premium Flow)
const taqdimotWizard = new Scenes.WizardScene(
    'taqdimotWizard',
    (ctx) => {
        ctx.scene.session.order = { service: 'Taqdimot yaratish' };
        ctx.reply("🎨 <b>Premium Taqdimot Yaratish</b>\n\nIltimos, taqdimot uchun mavzuni kiriting:", { parse_mode: 'HTML', ...wizardButtons });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, mavzuni kiriting:");
        ctx.scene.session.order.topic = ctx.message.text;

        const inlineKeyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('5 ta slayd', 'slides_5'),
                Markup.button.callback('10 ta slayd', 'slides_10')
            ],
            [
                Markup.button.callback('15 ta slayd', 'slides_15'),
                Markup.button.callback('20 ta slayd (Premium)', 'slides_20')
            ]
        ]);

        ctx.reply(`"${ctx.message.text}" mavzusi qabul qilindi.\n\nTaqdimot necha sahifadan iborat bo'lsin?`, inlineKeyboard);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.callbackQuery && ctx.callbackQuery.data.startsWith('slides_')) {
            await ctx.answerCbQuery();
            const slideCount = ctx.callbackQuery.data.split('_')[1];
            ctx.scene.session.order.slides = slideCount;
            
            ctx.reply("Qaysi tilda bo'lsin?", Markup.keyboard([
                ["🇺🇿 O'zbek (lotin)", "🇷🇺 Rus"],
                ["🇬🇧 Ingliz"],
                ["⬅️ Orqaga", "❌ Bekor qilish"]
            ]).oneTime().resize());
            return ctx.wizard.next();
        }
        
        if (await checkNavigation(ctx)) return;
        return ctx.reply("Iltimos, yuqoridagi tugmalardan birini tanlang yoki bekor qiling.");
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, tilni tanlang:");
        ctx.scene.session.order.language = ctx.message.text;
        
        const order = ctx.scene.session.order;
        const userId = ctx.from.id;
        const name = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || 'Noaniq';

        // Adminga xabar
        if (ADMIN_ID) {
            const adminMsg =
                `🎨 <b>PREMIUM TAQDIMOT BUYURTMASI</b>\n\n` +
                `👤 Mijoz: <b>${name}</b>\n` +
                `🆔 ID: <code>${userId}</code>\n` +
                `📌 Mavzu: <b>${order.topic}</b>\n` +
                `📊 Slaydlar: ${order.slides}\n` +
                `🌐 Til: ${order.language}`;
            bot.telegram.sendMessage(ADMIN_ID, adminMsg, { parse_mode: 'HTML' }).catch(() => {});
        }

        await ctx.reply(
            "✅ <b>Buyurtmangiz qabul qilindi!</b>\n\n" +
            `🎨 <b>${order.slides}</b> sahifalik Premium taqdimot tayyorlanmoqda.\n` +
            "⏳ Iltimos, 30-60 soniya kuting...",
            { parse_mode: 'HTML', ...Markup.removeKeyboard() }
        );
        
        processAIGeneration(userId, order);
        return ctx.scene.leave();
    }
);

// Study Guide yaratish Wizard
const studyGuideWizard = new Scenes.WizardScene(
    'studyGuideWizard',
    (ctx) => {
        ctx.scene.session.order = { service: 'Study Guide' };
        ctx.reply("📋 Study Guide (O'quv qo'llanma) yaratish uchun fan nomini kiriting:", wizardButtons);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, fan nomini kiriting:");
        ctx.scene.session.order.subject = ctx.message.text;
        ctx.reply("Mavzuni kiriting:", wizardButtons);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, mavzuni kiriting:");
        ctx.scene.session.order.topic = ctx.message.text;
        ctx.reply("Sinf/kurs darajasini tanlang:", Markup.keyboard([
            ["5-9 sinf", "10-11 sinf"],
            ["Oliy ta'lim"],
            ["⬅️ Orqaga", "❌ Bekor qilish"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, darajani tanlang:");
        ctx.scene.session.order.grade = ctx.message.text;
        ctx.reply("Qaysi tilda yozilsin?", Markup.keyboard([
            ["🇺🇿 O'zbek (lotin)", "🇷🇺 Rus"],
            ["🇬🇧 Ingliz"],
            ["⬅️ Orqaga", "❌ Bekor qilish"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, tilni tanlang:");
        ctx.scene.session.order.language = ctx.message.text;
        const order = ctx.scene.session.order;
        const cachedOrder = { ...order, userId: ctx.from.id, username: ctx.from.username || "yo'q" };
        ordersCache.set(ctx.from.id, cachedOrder);
        await ctx.reply("✅ <b>Study Guide tayyorlanmoqda!</b>\n\nIltimos, 15-20 soniya kuting...", { parse_mode: 'HTML', ...Markup.removeKeyboard() });
        processAIGeneration(ctx.from.id, cachedOrder);
        return ctx.scene.leave();
    }
);

// Flashcard yaratish Wizard
const flashcardWizard = new Scenes.WizardScene(
    'flashcardWizard',
    (ctx) => {
        ctx.scene.session.order = { service: 'Flashcard' };
        ctx.reply("🧠 Flashcard (Xotira kartochkalari) yaratish uchun fan nomini kiriting:", wizardButtons);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, fan nomini kiriting:");
        ctx.scene.session.order.subject = ctx.message.text;
        ctx.reply("Mavzuni kiriting:", wizardButtons);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, mavzuni kiriting:");
        ctx.scene.session.order.topic = ctx.message.text;
        ctx.reply("Nechta kartochka yaratilsin?", Markup.keyboard([
            ["10 ta", "15 ta"],
            ["20 ta", "30 ta"],
            ["⬅️ Orqaga", "❌ Bekor qilish"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        const count = parseInt(ctx.message.text);
        if (isNaN(count)) return ctx.reply("⚠️ Iltimos, faqat son kiriting:");
        
        ctx.scene.session.order.count = count;
        ctx.scene.session.order.pages = ctx.message.text;
        ctx.reply("Qaysi tilda yozilsin?", Markup.keyboard([
            ["🇺🇿 O'zbek (lotin)", "🇷🇺 Rus"],
            ["🇬🇧 Ingliz"],
            ["⬅️ Orqaga", "❌ Bekor qilish"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, tilni tanlang:");
        ctx.scene.session.order.language = ctx.message.text;
        const order = ctx.scene.session.order;
        const cachedOrder = { ...order, userId: ctx.from.id, username: ctx.from.username || "yo'q" };
        ordersCache.set(ctx.from.id, cachedOrder);
        await ctx.reply("✅ <b>Flashcardlar tayyorlanmoqda!</b>\n\nIltimos, 15-20 soniya kuting...", { parse_mode: 'HTML', ...Markup.removeKeyboard() });
        processAIGeneration(ctx.from.id, cachedOrder);
        return ctx.scene.leave();
    }
);

// OAK Maqola yaratish Wizard (Yangi talablar asosida)
const maqolaWizard = new Scenes.WizardScene(
    'maqolaWizard',
    (ctx) => {
        ctx.scene.session.order = { service: 'OAK Maqola' };
        ctx.reply("📝 <b>OAK Maqola yaratish</b>\n\nMaqola mavzusini kiriting:", { parse_mode: 'HTML', ...wizardButtons });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, mavzuni kiriting:");
        ctx.scene.session.order.topic = ctx.message.text;
        ctx.reply("👤 Muallif ism-sharifini kiriting (F.I.Sh):", wizardButtons);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, ism-sharifni kiriting:");
        ctx.scene.session.order.author = ctx.message.text;
        ctx.reply("🏢 Ish joyi yoki OTM nomini kiriting:", wizardButtons);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, muassasa nomini kiriting:");
        ctx.scene.session.order.institution = ctx.message.text;
        ctx.reply("🎓 Ilmiy daraja va unvoningizni kiriting:", wizardButtons);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, muassasa nomini kiriting:");
        ctx.scene.session.order.institution = ctx.message.text;
        ctx.reply("🎓 Ilmiy darajangizni kiriting:\n(Masalan: Magistr, PhD, DSc yoki 'Yo'q')", wizardButtons);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, ilmiy darajani kiriting:");
        ctx.scene.session.order.degree = ctx.message.text;
        ctx.reply("📧 E-mail manzilingizni kiriting:", wizardButtons);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text || !ctx.message.text.includes('@')) {
            return ctx.reply("⚠️ Xato e-mail format. Iltimos, to'g'ri e-mail kiriting:");
        }
        ctx.scene.session.order.email = ctx.message.text;
        ctx.reply("📞 Telefon raqamingizni kiriting:", wizardButtons);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, telefon raqamni kiriting:");
        ctx.scene.session.order.phone = ctx.message.text;
        ctx.reply("🌐 Asosiy tilni tanlang:", Markup.keyboard([
            ["🇺🇿 O'zbek (lotin)", "🇷🇺 Rus"],
            ["🇬🇧 Ingliz"],
            ["⬅️ Orqaga", "❌ Bekor qilish"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, tilni tanlang:");
        ctx.scene.session.order.language = ctx.message.text;
        const order = ctx.scene.session.order;
        const cachedOrder = { ...order, userId: ctx.from.id, username: ctx.from.username || "yo'q" };
        ordersCache.set(ctx.from.id, cachedOrder);
        await ctx.reply("✅ <b>Ma'lumotlar qabul qilindi!</b>\n\nOAK Maqola tayyorlanmoqda. Bu biroz uzoq davom etishi mumkin (40-60 soniya)...", { parse_mode: 'HTML', ...Markup.removeKeyboard() });
        processAIGeneration(ctx.from.id, cachedOrder);
        return ctx.scene.leave();
    }
);
// Maqola yozish Wizard (Oddiy uslubda)
const maqolaYozishWizard = new Scenes.WizardScene(
    'maqolaYozishWizard',
    (ctx) => {
        ctx.scene.session.order = { service: 'Maqola yozish' };
        ctx.reply("✍️ <b>Maqola yozish</b>\n\nMaqola mavzusini kiriting:", { parse_mode: 'HTML', ...wizardButtons });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, mavzuni kiriting:");
        ctx.scene.session.order.topic = ctx.message.text;
        ctx.reply("👤 Muallif ismini kiriting:", wizardButtons);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, muallif ismini kiriting:");
        ctx.scene.session.order.author = ctx.message.text;
        
        const order = ctx.scene.session.order;
        await ctx.reply("⏳ <b>Maqola tayyorlanmoqda...</b>", { parse_mode: 'HTML', ...Markup.removeKeyboard() });
        
        processAIGeneration(ctx.from.id, { ...order, userId: ctx.from.id });
        return ctx.scene.leave();
    }
);

// Jamoaviy Test Wizard
const jamoaviyTestWizard = new Scenes.WizardScene(
    'jamoaviyTestWizard',
    async (ctx) => {
        const sub = teacherSubs.get(ctx.from.id);
        const now = Date.now();
        
        if (!sub || !sub.isActive || sub.expiryTime < now) {
            // Obuna yo'q yoki muddati tugagan
            ctx.scene.session.state = 'buying';
            await ctx.reply(
                "👥 <b>Jamoaviy Test xizmatiga xush kelibsiz!</b>\n\n" +
                "Ushbu xizmat orqali siz bitta test yaratib, uni o'quvchilaringizga havola orqali tarqatishingiz va natijalarni real vaqtda kuzatishingiz mumkin.\n\n" +
                "🛑 <b>Sizda hozirda faol obuna yo'q.</b>\n\n" +
                "Obuna turlari:\n" +
                "1. 30 daqiqa — 10,000 so'm\n" +
                "2. 60 daqiqa — 15,000 so'm\n" +
                "3. 24 soat — 30,000 so'm\n\n" +
                "Davomiylikni tanlang:",
                Markup.inlineKeyboard([
                    [Markup.button.callback("30 daqiqa", "buy_team_30"), Markup.button.callback("60 daqiqa", "buy_team_60")],
                    [Markup.button.callback("24 soat", "buy_team_1440")],
                    [Markup.button.callback("❌ Bekor qilish", "cancel_wizard")]
                ])
            );
            return ctx.wizard.next();
        } else {
            // Faol obuna bor
            ctx.scene.session.state = 'creating';
            ctx.scene.session.order = { 
                service: 'Jamoaviy Test', 
                expiryTime: sub.expiryTime,
                teacherName: ctx.from.first_name || "O'qituvchi"
            };
            await ctx.reply("📝 <b>Jamoaviy Test yaratish</b>\n\nSavollar manbasini tanlang:", Markup.inlineKeyboard([
                [Markup.button.callback("✍️ Mavzu yozish", "source_topic")],
                [Markup.button.callback("📂 Fayl yuklash (PDF/DOCX)", "source_file")],
                [Markup.button.callback("❌ Bekor qilish", "cancel_wizard")]
            ]));
            return ctx.wizard.next();
        }
    },
    async (ctx) => {
        if (ctx.callbackQuery) {
            const data = ctx.callbackQuery.data;
            await ctx.answerCbQuery();
            
            if (data === 'cancel_wizard') {
                ctx.reply("❌ Amal bekor qilindi.", getMainMenu());
                return ctx.scene.leave();
            }
            
            if (ctx.scene.session.state === 'buying') {
                if (data.startsWith('buy_team_')) {
                    const duration = parseInt(data.split('_')[2]);
                    const prices = { 30: 10000, 60: 15000, 1440: 30000 };
                    const price = prices[duration];
                    
                    pendingPayments.set(ctx.from.id, { service: 'Jamoaviy Test', duration, price });
                    
                    await ctx.reply(
                        `💳 <b>To'lov ma'lumotlari:</b>\n\n` +
                        `Xizmat: Jamoaviy Test (${duration >= 1440 ? '24 soat' : duration + ' daqiqa'})\n` +
                        `Narxi: <b>${price.toLocaleString()} so'm</b>\n\n` +
                        `Karta: <code>${CARD_NUMBER}</code>\n` +
                        `Egasi: ${CARD_OWNER}\n\n` +
                        `To'lovni amalga oshirib, <b>chekni (skrinshot)</b> shu yerga yuboring. Tasdiqlangandan so'ng xizmat ochiladi.`,
                        { parse_mode: 'HTML', ...Markup.removeKeyboard() }
                    );
                    return ctx.scene.leave();
                }
            } else {
                // state === 'creating'
                if (data === 'source_topic') {
                    ctx.reply("Mavzu nomini yozing (AI test tuzishi uchun):", wizardButtons);
                    ctx.scene.session.sourceType = 'ai';
                } else {
                    ctx.reply("📁 Marhamat, faylni yuboring (PDF, DOCX yoki TXT):\n\nBot fayl ichidagi matnni tahlil qilib, o'zi avtomatik ravishda test savollarini tuzib chiqadi.", wizardButtons);
                    ctx.scene.session.sourceType = 'file';
                }
                return ctx.wizard.next();
            }
        }
        return;
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        
        // Matn yoki fayl qabul qilish logic
        if (ctx.scene.session.sourceType === 'file' && ctx.message.document) {
            const doc = ctx.message.document;
            const fileLink = await ctx.telegram.getFileLink(doc.file_id);
            const response = await fetch(fileLink.href);
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const text = await extractTextFromBuffer(buffer, doc.mime_type, doc.file_name);
            if (text) {
                // Har doim AI orqali yangi test tuziladi (fayl mazmuni asosida)
                ctx.scene.session.order.topic = `Fayl: ${doc.file_name}`;
                ctx.scene.session.order.contextText = text.substring(0, 10000); // Token limit
                ctx.scene.session.order.isManual = false;
                ctx.reply("✅ Fayl qabul qilindi. Bot fayl mazmuni asosida yangi test tuzib beradi.");
            } else {
                return ctx.reply("Faylni o'qib bo'lmadi. Qayta urinib ko'ring.");
            }
        } else if (ctx.scene.session.sourceType === 'ai' && ctx.message.text) {
            ctx.scene.session.order.topic = ctx.message.text;
            ctx.scene.session.order.isManual = false;
        } else {
            return ctx.reply("Iltimos, tanlovingizga mos ma'lumot yuboring.");
        }
        
        ctx.reply("👨‍🎓 <b>O'quvchilar soni</b>\n\nUshbu testni jami necha o'quvchi topshirishi kutilmoqda?\n(Masalan: 20)", wizardButtons);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        const count = parseInt(ctx.message.text);
        if (isNaN(count)) return ctx.reply("⚠️ Iltimos, faqat son kiriting:");
        
        ctx.scene.session.order.expectedStudents = count;
        ctx.reply("🌐 Test tili:", Markup.keyboard([
            ["🇺🇿 O'zbek (lotin)", "🇷🇺 Rus"],
            ["🇬🇧 Ingliz"],
            ["⬅️ Orqaga", "❌ Bekor qilish"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        ctx.scene.session.order.language = ctx.message.text;
        ctx.reply("Savollar soni:", Markup.keyboard([
            ["10 ta", "20 ta", "30 ta"],
            ["⬅️ Orqaga", "❌ Bekor qilish"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkNavigation(ctx)) return;
        const count = parseInt(ctx.message.text);
        ctx.scene.session.order.count = count || 10;
        
        await ctx.reply("⏳ <b>Jamoaviy test tayyorlanmoqda...</b>\nIltimos, kuting...", Markup.removeKeyboard());
        
        const order = ctx.scene.session.order;
        let finalQuestions = [];

        if (order.isManual) {
            finalQuestions = order.questions;
        } else {
            const systemPrompt = "Siz professional test tuzuvchisiz. Jamoaviy test uchun sifatli savollar yarating.";
            let prompt = `"${order.topic}" mavzusi bo'yicha professional test yarating.\n` +
                `Savollar soni: ${order.count} ta\n` +
                `Til: ${order.language}\n\n` +
                `FORMAT:\n` +
                `1. Savol?\n` +
                `A) Variant 1\n` +
                `B) Variant 2\n` +
                `C) Variant 3\n` +
                `D) Variant 4\n\n` +
                `JAVOBLAR KALITI:\n` +
                `1-A, 2-B, ...`;
            
            if (order.contextText) {
                prompt = `Quyidagi MATN ASOSIDA professional test yarating.\n` +
                    `Savollar soni: ${order.count} ta\n` +
                    `Til: ${order.language}\n\n` +
                    `MATN:\n${order.contextText}\n\n` +
                    `FORMAT:\n` +
                    `1. Savol?\n` +
                    `A) Variant 1\n` +
                    `B) Variant 2\n` +
                    `C) Variant 3\n` +
                    `D) Variant 4\n\n` +
                    `JAVOBLAR KALITI:\n` +
                    `1-A, 2-B, ...`;
            }

            const progMsg = await ctx.reply("⏳ <b>Test savollari tayyorlanmoqda...</b>", { parse_mode: 'HTML' });
            
            try {
                const responseText = await callAI(prompt, systemPrompt);
                if (!responseText) throw new Error("AI dan javob olinmadi.");
                
                finalQuestions = parseQuizText(responseText);
                
                if (finalQuestions && finalQuestions.length > 0) {
                    const teamId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
                    let shortCode;
                    do {
                        shortCode = Math.floor(100000 + Math.random() * 900000).toString();
                    } while (teamCodes.has(shortCode));

                    teamQuizStorage.set(teamId, {
                        topic: order.topic,
                        questions: finalQuestions,
                        teacherId: ctx.from.id,
                        teacherName: order.teacherName,
                        expiryTime: order.expiryTime,
                        expectedStudents: order.expectedStudents,
                        submissions: [],
                        code: shortCode
                    });
                    teamCodes.set(shortCode, teamId);
                    savePersistentData().catch(() => {});
                    
                    const webAppUrl = getWebAppUrl();
                    const link = webAppUrl ? `${webAppUrl}/?teamId=${teamId}&v=${Date.now()}` : null;
                    const remainingMs = order.expiryTime - Date.now();
                    const minutes = Math.max(0, Math.floor(remainingMs / 60000));
                    const seconds = Math.max(0, Math.floor((remainingMs % 60000) / 1000));
                    const timerStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
                    
                    let msgText = `✨ <b>JAMOAVIY TEST YARATILDI</b> ✨\n\n` +
                        `📚 <b>Mavzu:</b> ${esc(order.topic)}\n` +
                        `🎯 <b>O'quvchilar:</b> ${order.expectedStudents} ta\n` +
                        `🔑 <b>Kirish kodi:</b> <code>${shortCode}</code>\n\n`;
                    
                    if (link) msgText += `🔗 Kirish havolasi:\n${link}`;

                    await ctx.telegram.deleteMessage(ctx.chat.id, progMsg.message_id).catch(() => {});
                    const dashboard = await bot.telegram.sendMessage(ctx.from.id, msgText, { 
                        parse_mode: 'HTML', 
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback(`⏳ ${timerStr} | ➕ Vaqtni uzaytirish`, "extend_time")]
                        ])
                    });
                    const quizData = teamQuizStorage.get(teamId);
                    quizData.messageId = dashboard.message_id;
                    savePersistentData().catch(() => {});
                    
                } else {
                    throw new Error("AI savollarni yaratdi, lekin ularni o'qib bo'lmadi (Format xatosi).");
                }
            } catch (e) {
                console.error("Team Quiz AI error:", e);
                await ctx.telegram.deleteMessage(ctx.chat.id, progMsg.message_id).catch(() => {});
                ctx.reply(`⚠️ <b>Xatolik yuz berdi:</b>\n\n<code>${esc(e.message)}</code>\n\nIltimos, qayta urinib ko'ring yoki mavzuni aniqroq yozing.`, { parse_mode: 'HTML' });
            }
        }
        return ctx.scene.leave();
    }
);

const stage = new Scenes.Stage([darsRejasiWizard, uyVazifasiWizard, testWizard, taqdimotWizard, maqolaWizard, jamoaviyTestWizard, maqolaYozishWizard]);
bot.use(session());
bot.use(stage.middleware());

bot.action('extend_time', async (ctx) => {
    // Team kodi orqali teamId ni aniqlaymiz
    const text = ctx.callbackQuery.message.text;
    const match = text.match(/Kod:\s+(\d{6})/);
    let teamId = "unknown";
    if (match) {
        teamId = teamCodes.get(match[1]) || "unknown";
    }
    
    await ctx.answerCbQuery();
    ctx.reply("🕒 <b>Vaqtni uzaytirish</b>\n\nQancha vaqtga uzaytirmoqchisiz?", Markup.inlineKeyboard([
        [Markup.button.callback("➕ 30 daqiqa (10,000 so'm)", `ext_${teamId}_30`)],
        [Markup.button.callback("➕ 60 daqiqa (15,000 so'm)", `ext_${teamId}_60`)],
        [Markup.button.callback("➕ 24 soat (30,000 so'm)", `ext_${teamId}_1440`)]
    ]));
});

bot.action(/^ext_(.+)_(\d+)$/, async (ctx) => {
    const teamId = ctx.match[1];
    const duration = parseInt(ctx.match[2]);
    const prices = { 30: 10000, 60: 15000, 1440: 30000 };
    const price = prices[duration];
    
    pendingPayments.set(ctx.from.id, { service: 'Vaqtni uzaytirish', duration, price, teamId });
    
    await ctx.answerCbQuery();
    ctx.reply(
        `💳 <b>To'lov ma'lumotlari:</b>\n\n` +
        `Xizmat: Vaqtni uzaytirish (+${duration >= 1440 ? '24 soat' : duration + ' daqiqa'})\n` +
        `Narxi: <b>${price.toLocaleString()} so'm</b>\n\n` +
        `Karta: <code>${CARD_NUMBER}</code>\n` +
        `Egasi: ${CARD_OWNER}\n\n` +
        `To'lovni amalga oshirib, chekni (skrinshot) yuboring.`,
        { parse_mode: 'HTML' }
    );
});

function getMainMenu() {
    return Markup.keyboard([
        ["📝 Test yaratish", "📋 Dars rejasi"],
        ["📖 Uy vazifasi", "🎨 Taqdimot"],
        ["👥 Jamoaviy Test", "✍️ Maqola yozish"],
        ["ℹ️ Yordam"]
    ]).resize().placeholder("Tanlang...");
}

bot.start((ctx) => {
    uniqueUsers.add(ctx.from.id);
    ctx.reply(
        "👋 Assalomu alaykum, hurmatli ustoz!\n\n" +
        "🤖 Men sizning AI yordamchingizman. Quyidagi xizmatlardan foydalaning:\n\n" +
        "📝 <b>Test yaratish</b>\n📋 <b>Dars rejasi</b>\n📖 <b>Uy vazifasi</b>\n🎨 <b>Taqdimot</b>\n👥 <b>Jamoaviy Test</b>\n\n" +
        "Quyidagi menyudan tanlang:",
        { parse_mode: 'HTML', ...getMainMenu() }
    );
});

bot.hears("📝 Test yaratish", (ctx) => { ctx.scene.enter('testWizard'); });
bot.hears("📋 Dars rejasi", (ctx) => { ctx.scene.enter('darsRejasiWizard'); });
bot.hears("📖 Uy vazifasi", (ctx) => { ctx.scene.enter('uyVazifasiWizard'); });
bot.hears("🎨 Taqdimot", (ctx) => {
    const limit = taqdimotLimits.get(ctx.from.id) || 0;
    if (limit >= 3) {
        pendingPayments.set(ctx.from.id, { service: 'Taqdimot' });
        ctx.reply(`⚠️ <b>Taqdimot limitingiz tugagan!</b> (3/3)\n\nNarxi: 15,000 so'm\n\nKarta: <code>${CARD_NUMBER}</code>`, { parse_mode: 'HTML' });
    } else {
        taqdimotLimits.set(ctx.from.id, limit + 1);
        saveTaqdimotLimits().catch(() => {});
        ctx.scene.enter('taqdimotWizard');
    }
});
bot.hears("👥 Jamoaviy Test", (ctx) => { ctx.scene.enter('jamoaviyTestWizard'); });
bot.hears("✍️ Maqola yozish", (ctx) => { ctx.scene.enter('maqolaYozishWizard'); });
bot.hears("📝 OAK Maqola", (ctx) => { ctx.scene.enter('maqolaWizard'); });

bot.hears("ℹ️ Yordam", (ctx) => {
    const webAppUrl = getWebAppUrl();
    const docsUrl = webAppUrl ? `${webAppUrl}/docs.html?v=${Date.now()}` : null;
    
    ctx.reply(
        "ℹ️ <b>Yordam markazi</b>\n\n" +
        "Botdan foydalanish bo'yicha to'liq qo'llanmani pastdagi tugma orqali ko'rishingiz mumkin.\n\n" +
        "👤 <b>Admin:</b> @dil_parvozi\n" +
        "📞 <b>Aloqa:</b> +998 91 333 13 03\n\n" +
        "<i>ByteBot — ustozlarning eng yaqin yordamchisi.</i>",
        { 
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                docsUrl ? [Markup.button.webApp("📖 Qo'llanmani ochish", docsUrl)] : []
            ])
        }
    );
});

bot.command('admin', (ctx) => {
    if (ctx.from.id.toString() === ADMIN_ID) {
        const activeTeams = [...teamQuizStorage.values()].filter(q => q.expiryTime > Date.now()).length;
        const pendingCount = pendingPayments.size;
        ctx.reply(
            `📊 <b>Bot Statistikasi:</b>\n\n` +
            `👥 Botdan foydalanganlar: <b>${uniqueUsers.size}</b>\n` +
            `🛍 Jami buyurtmalar: <b>${totalOrders}</b>\n` +
            `👥 Faol jamoaviy testlar: <b>${activeTeams}</b>\n` +
            `💳 Kutilayotgan to'lovlar: <b>${pendingCount}</b>`,
            { parse_mode: 'HTML', ...getMainMenu() }
        );
    } else {
        ctx.reply("Sizda admin huquqi yo'q.", getMainMenu());
    }
});

// Admin uchun foydalanuvchiga fayl yuborish buyrug'i
bot.command('send', (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("Sizda admin huquqi yo'q.", getMainMenu());
    const parts = ctx.message.text.split(' ');
    const targetUserId = parts[1];
    if (!targetUserId) return ctx.reply("❌ Foydalanuvchi ID'sini kiriting.\nFormat: /send 123456789", getMainMenu());
    pendingSendTargets.set(ctx.from.id, parseInt(targetUserId));
    ctx.reply(`📎 Foydalanuvchi ID: <code>${targetUserId}</code> ga yuborish uchun hozir faylni yuboring.\n\n⏳ Faylni kutmoqda...`, { parse_mode: 'HTML', ...getMainMenu() });
});

bot.command('cancel', (ctx) => {
    ctx.reply("Bekor qilindi.", getMainMenu());
    ctx.scene.leave();
});

// Qisqa kod orqali testga qo'shilish
bot.on('text', async (ctx, next) => {
    const text = ctx.message.text;
    if (/^\d{6}$/.test(text)) {
        const teamId = teamCodes.get(text);
        if (teamId) {
            const teamQuiz = teamQuizStorage.get(teamId);
            const now = Date.now();
            if (teamQuiz && teamQuiz.expiryTime > now) {
                const webAppUrl = getWebAppUrl();
                if (!webAppUrl) {
                    return ctx.reply("⏳ Tizim hozirda tarmoqqa ulanmoqda, iltimos 10-15 soniyadan so'ng parolni qayta yuboring.");
                }
                const link = `${webAppUrl}/?teamId=${teamId}`;
                const clockEmojis = ['🕛', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚'];
                const clock = clockEmojis[Math.floor(Date.now() / 5000) % clockEmojis.length];
                
                return ctx.reply(
                    `💎 <b>JAMOAVIY TEST TOPILDI!</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `👨‍🏫 Ustoz: <b>${esc(teamQuiz.teacherName)}</b>\n` +
                    `📌 Mavzu: <b>${esc(teamQuiz.topic)}</b>\n` +
                    `👥 Kutilmoqda: <b>${teamQuiz.expectedStudents} o'quvchi</b>\n` +
                    `📝 Savollar: <b>${teamQuiz.questions.length} ta</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `${clock} <i>Testda qatnashish uchun quyidagi tugmani bosing:</i>`,
                    { 
                        parse_mode: 'HTML',
                        ...Markup.inlineKeyboard([
                            [Markup.button.webApp("🚀 Testga kirish", link)]
                        ])
                    }
                );
            } else {
                return ctx.reply("⚠️ Ushbu test kodi eskirgan yoki muddati tugagan.");
            }
        }
    }
    return next();
});


// -------------------------------------------------------------
// CORE AI GENERATION HELPERS
// -------------------------------------------------------------
async function callAI(prompt, systemPrompt = "Siz tajribali o'qituvchi va ta'lim sohasida AI yordamchisisiz. Berilgan vazifani professional darajada, aniq va sifatli bajaring. Javoblaringiz o'zbek tilida bo'lsin.", modelType = 'fast') {
    const aiErrors = [];



    const models = {
        groq: async () => {
            if (!process.env.GROQ_API_KEY) return null;
            const groqModels = ["llama-3.1-8b-instant", "llama3-70b-8192", "mixtral-8x7b-32768"];
            for (const modelName of groqModels) {
                try {
                    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: modelName,
                            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }],
                            temperature: 0.6,
                            max_tokens: 3000 
                        })
                    });
                    if (resp.ok) {
                        const data = await resp.json();
                        return data.choices?.[0]?.message?.content || null;
                    }
                    const err = await resp.json().catch(() => ({}));
                    const msg = err.error?.message || resp.status.toString();
                    aiErrors.push(`Groq (${modelName}): ${msg}`);
                    if (!msg.includes("limit") && !msg.includes("429")) break; // Faqat limit bo'lsa keyingi modelga o'tish
                } catch (e) { aiErrors.push(`Groq Error (${modelName}): ${e.message}`); }
            }
            return null;
        },
        gemini: async () => {
            if (!genAI) return null;
            try {
                // modelType ga qarab modelni tanlash
                let modelName = "gemini-1.5-flash";
                if (modelType === 'pro' || modelType === 'academic') {
                    modelName = "gemini-1.5-pro";
                }
                
                const model = genAI.getGenerativeModel({ model: modelName });
                const result = await model.generateContent(`${systemPrompt}\n\n${prompt}`);
                const response = await result.response;
                return response.text();
            } catch (e) { 
                // Fallback
                if (modelType === 'pro' || modelType === 'academic') {
                    try {
                        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                        const result = await model.generateContent(`${systemPrompt}\n\n${prompt}`);
                        const response = await result.response;
                        return response.text();
                    } catch (flashError) {
                        try {
                            const model = genAI.getGenerativeModel({ model: "gemini-1.0-pro" });
                            const result = await model.generateContent(`${systemPrompt}\n\n${prompt}`);
                            const response = await result.response;
                            return response.text();
                        } catch (e) {}
                        aiErrors.push(`Gemini Flash Fallback: ${flashError.message}`);
                    }
                } else {
                    try {
                        const model = genAI.getGenerativeModel({ model: "gemini-1.0-pro" });
                        const result = await model.generateContent(`${systemPrompt}\n\n${prompt}`);
                        const response = await result.response;
                        return response.text();
                    } catch (oldProError) {}
                }
                aiErrors.push(`Gemini SDK (${modelType}): ${e.message}`); 
            }
            return null;
        },
        deepseek: async () => {
            if (!process.env.OPENROUTER_API_KEY) return null;
            try {
                const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': 'https://bytebot.ai',
                        'X-Title': 'ByteBot'
                    },
                    body: JSON.stringify({
                        model: "deepseek/deepseek-chat",
                        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }],
                        max_tokens: 1500
                    })
                });
                if (resp.ok) {
                    const data = await resp.json();
                    return data.choices?.[0]?.message?.content || null;
                }
                const err = await resp.json().catch(() => ({}));
                aiErrors.push(`DeepSeek: ${err.error?.message || resp.status}`);
            } catch (e) { aiErrors.push(`DeepSeek Error: ${e.message}`); }
            return null;
        },
        claude: async () => {
            if (!process.env.ANTHROPIC_API_KEY) return null;
            try {
                const Anthropic = require('@anthropic-ai/sdk');
                const cl = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
                const msg = await cl.messages.create({
                    model: "claude-3-5-sonnet-20241022",
                    max_tokens: 8000,
                    temperature: 0.3,
                    messages: [{ role: "user", content: `${systemPrompt}\n\n${prompt}` }]
                });
                return msg.content?.[0]?.text || null;
            } catch (e) { aiErrors.push(`Claude: ${e.message}`); }
            return null;
        }
    };

    const academicChain = ['gemini', 'claude', 'deepseek', 'groq'];
    const fastChain = ['gemini', 'groq', 'deepseek', 'claude'];
    const chain = (modelType === 'academic' || modelType === 'pro') ? academicChain : fastChain;

    for (const modelKey of chain) {
        // Skip Groq if prompt is too large for free tier
        if (modelKey === 'groq' && prompt.length > 10000) continue;
        
        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
            try {
                const result = await models[modelKey]();
                if (result && result.length > 10) return result;
                
                // If result is null, it might be an API error logged in aiErrors
                attempts++;
                if (attempts < maxAttempts) {
                    await new Promise(r => setTimeout(r, 2000 * attempts)); // Backoff
                }
            } catch (e) {
                attempts++;
                aiErrors.push(`${modelKey} Attempt ${attempts} Error: ${e.message}`);
                if (attempts < maxAttempts) {
                    await new Promise(r => setTimeout(r, 2000 * attempts));
                }
            }
        }
    }

    const uniqueErrors = [...new Set(aiErrors)].slice(-5); // Show last 5 unique errors
    throw new Error(uniqueErrors.join("\n") || "Barcha AI tizimlari band.");
}

async function processAIGeneration(userId, order, existingMsgId = null) {
    const currentYear = new Date().getFullYear();
    let msgId = existingMsgId;
    if (!msgId) {
        const statusTexts = {
            'Test yaratish': "Test savollari shakllantirilmoqda...",
            'Dars rejasi': "Dars rejasi tuzilmoqda...",
            'Uy vazifasi': "Topshiriqlar yaratilmoqda...",
            'Study Guide': "O'quv qo'llanma tayyorlanmoqda...",
            'Flashcard': "Xotira kartochkalari yaratilmoqda...",
            'Taqdimot yaratish': "Slaydlar tarkibi tayyorlanmoqda...",
            'OAK Maqola': "Akademik maqola yozilmoqda..."
        };
        const statusText = statusTexts[order.service] || "Mavzu tahlil qilinmoqda...";
        const progMsg = await bot.telegram.sendMessage(userId, `⏳ <b>Sizning so'rovingiz qabul qilindi!</b>\n\n${getProgressBar(10)}\n\n💠 ${statusText}\n\n<i>Iltimos, 15-20 soniya kuting...</i>`, { parse_mode: 'HTML' }).catch(() => { });
        msgId = progMsg?.message_id;
    }

    try {
        let responseText = "";
        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        let pCount = 5;
        if (order.pages) {
            const matches = order.pages.match(/(\d+)/g);
            if (matches && matches.length >= 2) {
                // Range berilgan (masalan "5-8 bet"), o'rtachasini olamiz
                pCount = (parseInt(matches[0]) + parseInt(matches[1])) / 2;
            } else if (matches && matches.length === 1) {
                pCount = parseInt(matches[0]);
            }
        }
        const targetWords = pCount * 450; // Target upper limit: 1 page = 450 words

        let prompt = "";
        let customSystemPrompt = undefined;

        if (order.service === 'Dars rejasi') {
            customSystemPrompt = "Siz tajribali pedagog va metodik mutaxassisisiz. Professional dars rejalarini tuzish bo'yicha ekspertsiz.";
            prompt = `"${order.subject}" fanidan "${order.topic}" mavzusida professional DARS REJASI tuzing.

Daraja: ${order.grade}
Davomiylik: ${order.duration}
Til: ${order.language}

DARS REJASI STRUKTURASI:
1. **Dars mavzusi** — to'liq nomi
2. **Darsning maqsadi** — ta'limiy, tarbiyaviy, rivojlantiruvchi
3. **Dars turi** — (yangi mavzu, mustahkamlash, aralash va h.k.)
4. **Dars usullari** — (interfaol, an'anaviy, guruhlarda ishlash va h.k.)
5. **Dars jihozlari** — kerakli qurollar va materiallar
6. **Darsning borishi:**
   a) Tashkiliy qism (2-3 daqiqa)
   b) O'tgan mavzuni so'rash (5-7 daqiqa) — savollar bilan
   c) Yangi mavzuni tushuntirish (15-20 daqiqa) — batafsil, misollar bilan
   d) Mustahkamlash (8-10 daqiqa) — mashqlar, savollar
   e) Baholash va uyga vazifa (3-5 daqiqa)
7. **Dars xulosalandirmasi**

Har bir bo'limni batafsil yozing. Daqiqalar ${order.duration} ga mos bo'lsin.`;

        } else if (order.service === 'Uy vazifasi') {
            customSystemPrompt = "Siz tajribali pedagog va mashq tuzuvchisisiz. O'quvchilar uchun sifatli va qiziqarli topshiriqlar yaratish bo'yicha ekspertsiz.";
            prompt = `"${order.subject}" fanidan "${order.topic}" mavzusida UY VAZIFASI tuzing.

Daraja: ${order.grade}
Topshiriqlar soni: ${order.count || 10} ta
Qiyinlik: ${order.difficulty || "O'rtacha"}
Til: ${order.language}

TALABLAR:
1. Har bir topshiriq aniq va tushunarli bo'lsin
2. Topshiriqlar turli xil bo'lsin (nazariy savollar, amaliy mashqlar, tahliliy topshiriqlar)
3. Qiyinlik darajasi bosqichma-bosqich oshib borsin
4. Javoblar alohida bo'limda berilsin
5. Raqamlangan format: 1. Topshiriq matni

STRUKTURA:
- **Mavzu:** ${order.topic}
- **Fan:** ${order.subject}
- **Topshiriqlar** (${order.count || 10} ta)
- **Javoblar kaliti**`;

        } else if (order.service === 'Test yaratish') {
            customSystemPrompt = "Siz o'quv materiallari va testlar bo'yicha mutaxassissiz. Sizning vazifangiz berilgan mavzu yoki matn bo'yicha aniq sondagi testlarni sifatli yaratish. Har bir savolda 4 ta variant bo'lishi va oxirida javoblar kaliti bo'lishi shart.";
            
            let contextInstr = "";
            if (order.contextText) {
                let sampledText = order.contextText;
                if (order.contextText.length > 20000) {
                    sampledText = order.contextText.substring(0, 10000) + 
                                  "\n... [MATN QISQARTIRILDI] ...\n";
                }
                contextInstr = `\nQUYIDAGI MATN ASOSIDA SAVOLLAR TUZING:\n---\n${sampledText}\n---\n`;
            }

            prompt = `Vazifa: "${order.topic}" mavzusi bo'yicha QAT'IY ${order.count} TA test savoli yarating.${contextInstr}
MURAKKABLIK DARAJA: ${order.difficulty || 'O\'rtacha'}.

MAJBURIY TALABLAR:
1. SAVOLLAR SONI: ${order.count} ta.
2. Murakkablik: ${order.difficulty === 'Sodda' ? 'Savollar oson va asosiy tushunchalarga oid bo\'lsin.' : (order.difficulty === 'Kuchli' ? 'Savollar mantiqiy, qiyin va chuqur bilim talab qiladigan bo\'lsin.' : 'Savollar o\'rtacha murakkablikda bo\'lsin.')}
3. Har bir savolda 4 ta variant (A, B, C, D) bo'lsin.
4. Til: ${order.language}.
5. FORMAT:
   1. Savol matni?
      A) Variant
      B) Variant
      C) Variant
      D) Variant

6. JAVOBLAR KALITI: Eng oxirida kalitni bering:
   JAVOBLAR KALITI:
   1-A
   2-B
   ...

DIQQAT: To'g'ri javoblarni aralashtiring.
MUHIM: Oxirigacha ${order.count}-savolgacha yozing.`;

        } else if (order.service === 'Study Guide') {
            customSystemPrompt = "Siz tajribali pedagog va o'quv materiallar yaratuvchisisiz. Sifatli, tuzilgan va tushunarli o'quv qo'llanmalar yaratish bo'yicha ekspertsiz.";
            prompt = `"${order.subject}" fanidan "${order.topic}" mavzusida batafsil STUDY GUIDE (O'QUV QO'LLANMA) yarating.

Daraja: ${order.grade}
Til: ${order.language}

STUDY GUIDE STRUKTURASI:
1. **Mavzu haqida umumiy ma'lumot** — 2-3 paragraf
2. **Asosiy tushunchalar lug'ati** — 10-15 ta atama va ta'riflari
3. **Mavzuning asosiy bo'limlari** — har biri batafsil tushuntirilgan (3-5 ta bo'lim)
4. **Muhim formulalar/qoidalar/faktlar** — ro'yxat ko'rinishida
5. **Amaliy misollar** — 3-5 ta yechilgan misol
6. **O'z-o'zini tekshirish savollari** — 10 ta savol (javoblari bilan)
7. **Qo'shimcha manbalar** — tavsiya etiladigan kitoblar va saytlar

Har bir bo'limni BATAFSIL va SIFATLI yozing.`;

        } else if (order.service === 'Flashcard') {
            customSystemPrompt = "Siz ta'lim sohasidagi xotira kartochkalari (flashcard) yaratish bo'yicha ekspertsiz. Samarali va esda qolarli kartochkalar yarating.";
            prompt = `"${order.subject}" fanidan "${order.topic}" mavzusida ${order.count || 15} ta FLASHCARD (XOTIRA KARTOCHKASI) yarating.

            
            Til: ${order.language}
            
            HAR BIR KARTOCHKA FORMATI:
            📝 **Kartochka #N**
            ❓ **Savol:** [Savol yoki tushuncha]
            ✅ **Javob:** [Qisqa va aniq javob]
            💡 **Eslatma:** [Esda qolishi uchun qisqa izoh yoki misol]
            
            TALABLAR:
            1. Jami ${order.count || 15} ta kartochka yarating
            2. Savollar turli xil bo'lsin (ta'rif, tushuncha, formula, fakt)
            3. Javoblar qisqa, aniq va esda qolarli bo'lsin
            4. Eslatmalar o'quvchiga yordam beradigan bo'lsin
            5. Qiyinlik bosqichma-bosqich oshsin`;

        } else if (order.service === 'Taqdimot yaratish') {
            customSystemPrompt = "Siz professional taqdimot dizayneri va kontent menejerisiz. Slaydlar mazmuni qisqa, tushunarli va vizual jihatdan boy bo'lishi kerak.";
            prompt = `Mavzu: "${order.topic}". 
Ushbu mavzu bo'yicha qat'iy ravishda roppa-rosa ${order.slides} ta slayddan iborat PREMIUM prezentatsiya rejasi tuzib ber.
Til: ${order.language}.

Javobni faqat va faqat quyidagi JSON formatida qaytar (hech qanday qo'shimcha matn, tushuntirish yoki \`\`\`json belgilari kerak emas!):
[
  {
    "title": "Slayd sarlavhasi (Mavzuga mos chiroyli emoji bilan)",
    "layout": "split", 
    "left_content": ["Chap ustun tezisi 1", "Chap ustun tezisi 2"],
    "right_content": ["O'ng ustun tezisi 1", "O'ng ustun tezisi 2"],
    "keyword": "vizual rasm uchun inglizcha kalit so'zlar"
  },
  {
    "title": "Keyingi slayd sarlavhasi",
    "layout": "single",
    "content": ["Asosiy kontent tezisi 1", "Asosiy kontent tezisi 2"],
    "keyword": "vizual rasm uchun inglizcha kalit so'zlar"
  }
]
Muhim: Massivdagi slaydlar soni aniq ${order.slides} ta bo'lsin. "layout" qiymatlarini "split" va "single" qilib aralashtirib ishlat. Har bir slayd uchun "keyword" albatta bo'lsin.`;

        } else if (order.service === 'OAK Maqola') {
            customSystemPrompt = "Siz ilmiy xodim va akademik maqolalar bo'yicha ekspertsiz. O'zbekiston OAK (Oliy Attestatsiya Komissiyasi) standartlari asosida sifatli ilmiy maqola yarating.";
            prompt = `"${order.topic}" mavzusida professional ilmiy MAQOLA yarating.
            
            MA'LUMOTLAR:
            - Muallif: ${order.author}
            - Muassasa: ${order.institution}
            - Daraja: ${order.degree}
            - E-mail: ${order.email}
            - Tel: ${order.phone}
            - Tanlangan til: ${order.language}
            
            MAQOLA TUZILISHI (MAJBURIY):
            1. **MAQOLA SARLAVHASI** (3 tilda: O'zbek, Rus, Ingliz)
            2. **MUALLIF HAQIDA MA'LUMOT** (F.I.Sh., ish joyi, ilmiy daraja, e-mail, telefon)
            3. **ANNOTATSIYA** (3 tilda: O'zbek, Rus, Ingliz. Har biri 100-250 so'zdan bo'lsin)
            4. **KALIT SO'ZLAR** (6-8 ta, 3 tilda)
            5. **KIRISH** (Introduction) - Mavzuning dolzarbligi va maqsadini batafsil yozing.
            6. **ASOSIY QISM** (Main Body) - Tadqiqot metodologiyasi, tahlil va natijalarni o'z ichiga olsin. Jadval ma'lumotlarini ham bering.
            7. **XULOSA** (Conclusion) - Tadqiqotning amaliy ahamiyati va takliflar.
            8. **ADABIYOTLAR RO'YXATI** (References) - Kamida 8-10 ta dolzarb ilmiy manba (xalqaro standartda).
            
            TALABLAR:
            - Akademik tilda yozing.
            - Plagiat bo'lmasligi uchun o'ziga xos fikrlarni bering.
            - Har bir bo'limni juda batafsil yozing (Maqola umumiy hajmi kamida 2000-3000 so'z bo'lishi kerak).
            - Muhim fikrlarga matn ichida havolalar [1], [2] ko'rinishida bering.`;
        } else if (order.service === 'Maqola yozish') {
            customSystemPrompt = "Siz tajribali maqola yozuvchi mutaxassissiz.";
            prompt = `"${order.topic}" mavzusida qiziqarli maqola yozing.\nMuallif: ${order.author}\n\nStruktura:\n1. Sarlavha\n2. Muallif\n3. Mavzu haqida batafsil ma'lumot (500-1000 so'z)`;
        }

        await updateProgress(userId, msgId, 30, "Mavzu strukturasi tuzilmoqda...");

        // Xizmatga qarab model turini tanlash
        let modelType = 'fast';
        if (order.service === 'OAK Maqola') modelType = 'academic';
        if (order.service === 'Taqdimot yaratish') modelType = 'pro';
        if (order.service === 'Study Guide') modelType = 'pro';

        // Single stage generation for all services
        responseText = await callAI(prompt, customSystemPrompt, modelType);

        if (!responseText) throw new Error("No AI responded.");

        if (order.service === 'Test yaratish') {
            const parsedQuiz = parseQuizText(responseText);
            if (parsedQuiz) {
                quizStorage.set(userId, {
                    topic: order.topic || 'Yangi Test',
                    questions: parsedQuiz,
                    timestamp: Date.now()
                });
                saveQuizzes().catch(() => {});
            }
        }
        // Flashcard ma'lumotlarini tayyorlash
        if (order.service === 'Flashcard') {
            const cards = parseFlashcardText(responseText);
            if (cards && cards.length > 0) {
                flashcardStorage.set(userId, cards);
            }
        }

        if (order.service === 'Taqdimot yaratish') {
            let slides;
            try {
                const cleanJsonText = responseText.trim().replace(/^\`\`\`json/, '').replace(/\`\`\`$/, '').trim();
                slides = JSON.parse(cleanJsonText);
            } catch (e) {
                console.error("JSON Parsing Error:", e);
                // Fallback: try to parse with the old parser if JSON fails
                slides = parsePresentationText(responseText);
            }
            
            if (!slides || !Array.isArray(slides)) throw new Error("Slaydlarni shakllantirishda xatolik yuz berdi.");

            await updateProgress(userId, msgId, 90, "PowerPoint fayl yaratilmoqda...");
            
            const pres = new pptxgen();
            pres.layout = 'LAYOUT_16x9';

            const themeKeys = Object.keys(PPTX_THEMES);
            const theme = PPTX_THEMES[themeKeys[Math.floor(Math.random() * themeKeys.length)]];

            // Title Slide
            let slide0 = pres.addSlide();
            slide0.background = { color: theme.bg };
            slide0.addShape(pres.ShapeType.rtTriangle, { x: 0, y: 0, w: 5, h: 5, fill: { color: theme.titleColor, transparency: 85 }, flipH: true });
            slide0.addShape(pres.ShapeType.rect, { x: "75%", y: 0, w: "25%", h: "100%", fill: { color: theme.accent, transparency: 90 } });

            slide0.addText(order.topic.toUpperCase(), { 
                x: 0.5, y: "35%", w: "90%", h: 1.5, 
                align: "center", fontSize: 44, bold: true, color: theme.titleColor, fontFace: theme.font
            });
            slide0.addText(`Tayyorladi: AI Yordamchi`, { 
                x: 0, y: "55%", w: "100%", h: 0.5, 
                align: "center", fontSize: 24, color: theme.textColor, fontFace: theme.font
            });

            // Content Slides - Parallel image fetching
            await updateProgress(userId, msgId, 40, "Slaydlar uchun rasmlar tayyorlanmoqda...");
            
            const imagePromises = slides.map(s => s.keyword ? getImageBase64(s.keyword) : Promise.resolve(null));
            const images = await Promise.all(imagePromises);

            await updateProgress(userId, msgId, 70, "Slaydlar shakllantirilmoqda...");

            for (let i = 0; i < slides.length; i++) {
                const s = slides[i];
                const base64Image = images[i];
                let slide = pres.addSlide();
                slide.background = { color: theme.bg };

                // Background decoration
                slide.addShape(pres.ShapeType.rect, { x: 0, y: "92%", w: "100%", h: "8%", fill: { color: theme.titleColor, transparency: 80 } });
                slide.addText(`${i + 1}`, { x: "95%", y: "93%", fontSize: 12, color: theme.textColor });

                // Title
                slide.addText(s.title || "Slayd", { 
                    x: 0.5, y: 0.2, w: "90%", h: 0.8, 
                    fontSize: 28, bold: true, color: theme.titleColor, fontFace: theme.font,
                    border: { type: "solid", color: theme.accent, pt: 1, border: [false, false, true, false] }
                });

                if (s.layout === 'split') {
                    // Split Layout (Left and Right columns)
                    const leftPoints = (s.left_content || []).map(p => ({ text: p, options: { bullet: true, color: theme.textColor, fontSize: 16 } }));
                    const rightPoints = (s.right_content || []).map(p => ({ text: p, options: { bullet: true, color: theme.textColor, fontSize: 16 } }));

                    slide.addText(leftPoints, { x: 0.5, y: 1.2, w: "45%", h: 3.5, valign: "top" });
                    slide.addText(rightPoints, { x: 5.0, y: 1.2, w: "45%", h: 3.5, valign: "top" });
                    
                    if (base64Image) {
                        slide.addImage({ data: base64Image, x: 7.5, y: 4.5, w: 2.2, h: 1.4 });
                    }
                } else {
                    // Single Layout (Default)
                    const points = (s.content || []).map(p => ({ text: p, options: { bullet: true, color: theme.textColor, fontSize: 18 } }));
                    
                    const hasImage = !!base64Image;
                    const textWidth = hasImage ? "55%" : "90%";
                    
                    slide.addText(points, { x: 0.5, y: 1.2, w: textWidth, h: 4.0, valign: "top" });

                    if (hasImage) {
                        slide.addImage({ data: base64Image, x: 6.0, y: 1.2, w: 3.5, h: 4.0 });
                        slide.addShape(pres.ShapeType.rect, { x: 5.9, y: 1.1, w: 3.7, h: 4.2, line: { color: theme.accent, pt: 1 } });
                    }
                }
            }

            // End Slide
            let slideEnd = pres.addSlide();
            slideEnd.background = { color: theme.bg };
            slideEnd.addText("E'TIBORINGIZ UCHUN RAHMAT!", { 
                x: 0, y: "45%", w: "100%", h: 1, 
                align: "center", fontSize: 44, bold: true, color: theme.accent, fontFace: theme.font
            });

            const fileName = `Premium_Taqdimot_${Date.now()}.pptx`;
            const buffer = await pres.write("nodebuffer");
            
            await updateProgress(userId, msgId, 100, "Tayyor! Yuborilmoqda...");
            await bot.telegram.sendDocument(userId, { source: buffer, filename: fileName }, { 
                caption: `🎨 <b>Sizning mukammal taqdimotingiz tayyor!</b>\n\nMavzu: ${order.topic}\nSlaydlar: ${slides.length}\nTema: ${themeKeys.find(k => PPTX_THEMES[k] === theme)}\n\nBotimizdan foydalanganingiz uchun rahmat!`, 
                parse_mode: 'HTML',
                ...getMainMenu()
            });
            return;
        }

        await updateProgress(userId, msgId, 80, "Word hujjat shakllantirilmoqda...");

        // Title paragraph
        let paragraphs = [
            new Paragraph({
                children: [new TextRun({ text: (order.topic || order.service).toUpperCase(), bold: true, size: 32 })],
                alignment: AlignmentType.CENTER,
                spacing: { before: 200, after: 400 }
            })
        ];
        if (order.subject) {
            paragraphs.push(new Paragraph({
                children: [new TextRun({ text: `Fan: ${order.subject}`, bold: true, size: 24 })],
                alignment: AlignmentType.CENTER,
                spacing: { after: 400 }
            }));
        }

        if (order.service === 'Flashcard') {
            const cards = flashcardStorage.get(userId);
            if (cards && cards.length > 0) {
                const docxRows = [];
                // Header row
                docxRows.push(new TableRow({
                    children: [
                        new TableCell({ children: [new Paragraph({ text: "SAVOL", alignment: AlignmentType.CENTER })], margins: { top: 150, bottom: 150, left: 150, right: 150 } }),
                        new TableCell({ children: [new Paragraph({ text: "JAVOB VA ESLATMA", alignment: AlignmentType.CENTER })], margins: { top: 150, bottom: 150, left: 150, right: 150 } })
                    ]
                }));
                
                // Card rows
                for (const c of cards) {
                    docxRows.push(new TableRow({
                        children: [
                            new TableCell({ 
                                children: [new Paragraph({ children: [new TextRun({ text: c.question, size: 28, bold: true })] })],
                                margins: { top: 200, bottom: 200, left: 200, right: 200 }
                            }),
                            new TableCell({ 
                                children: [
                                    new Paragraph({ children: [new TextRun({ text: c.answer, size: 24 })] }),
                                    new Paragraph({ children: [new TextRun({ text: c.hint ? `💡 Eslatma: ${c.hint}` : '', size: 20, italics: true })], spacing: { before: 120 } })
                                ],
                                margins: { top: 200, bottom: 200, left: 200, right: 200 }
                            })
                        ]
                    }));
                }
                
                paragraphs.push(new Table({
                    rows: docxRows,
                    width: { size: 100, type: WidthType.PERCENTAGE },
                    borders: {
                        top: { style: BorderStyle.DOUBLE, size: 3, color: "6c5ce7" },
                        bottom: { style: BorderStyle.DOUBLE, size: 3, color: "6c5ce7" },
                        left: { style: BorderStyle.DOUBLE, size: 3, color: "6c5ce7" },
                        right: { style: BorderStyle.DOUBLE, size: 3, color: "6c5ce7" },
                        insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "a29bfe" },
                        insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "a29bfe" },
                    }
                }));
            }
        } else {
            const lines = responseText.split('\n');
        let tableRowsData = [];

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            let cleanLine = line.trim();
            if (cleanLine === '') continue;

            // Table support
            if (cleanLine.startsWith('|') && cleanLine.endsWith('|')) {
                tableRowsData.push(cleanLine);
                const nextLine = lines[i+1]?.trim();
                if (!nextLine || !(nextLine.startsWith('|') && nextLine.endsWith('|'))) {
                    const docxRows = [];
                    for (let r = 0; r < tableRowsData.length; r++) {
                        const rowStr = tableRowsData[r];
                        if (rowStr.includes('---')) continue; 
                        const cells = rowStr.split('|').slice(1, -1).map(c => c.trim());
                        const isHeader = (r === 0);
                        const docxCells = cells.map(cellText => new TableCell({
                            children: [new Paragraph({
                                children: [new TextRun({ text: cellText, bold: isHeader, size: 22 })],
                                alignment: AlignmentType.CENTER
                            })],
                            margins: { top: 100, bottom: 100, left: 100, right: 100 }
                        }));
                        if (docxCells.length > 0) docxRows.push(new TableRow({ children: docxCells }));
                    }
                    if (docxRows.length > 0) {
                        paragraphs.push(new Table({
                            rows: docxRows,
                            width: { size: 100, type: WidthType.PERCENTAGE },
                            borders: {
                                top: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
                                bottom: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
                                left: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
                                right: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
                                insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
                                insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
                            }
                        }));
                        paragraphs.push(new Paragraph({ text: "", spacing: { after: 200 } }));
                    }
                    tableRowsData = [];
                }
                continue;
            }

            // Heading detection
            const isHeading = cleanLine.startsWith('#') || (cleanLine.startsWith('**') && cleanLine.endsWith('**'));
            const rawLine = cleanLine.replace(/^#+\s*/, '');

            if (isHeading) {
                paragraphs.push(new Paragraph({
                    children: [new TextRun({ text: rawLine.replace(/[*_]/g, ''), bold: true, size: 24 })],
                    alignment: AlignmentType.LEFT,
                    spacing: { before: 240, after: 120 }
                }));
            } else {
                // Process bold and italics
                const children = [];
                const parts = rawLine.split(/(\*\*.*?\*\*|\*.*?\*|_.*?_)/g);
                for (let part of parts) {
                    if (part.startsWith('**') && part.endsWith('**')) {
                        children.push(new TextRun({ text: part.slice(2, -2), bold: true, size: 24 }));
                    } else if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) {
                        children.push(new TextRun({ text: part.slice(1, -1), italics: true, size: 24 }));
                    } else if (part) {
                        children.push(new TextRun({ text: part, size: 24 }));
                    }
                }
                paragraphs.push(new Paragraph({
                    children: children,
                    alignment: AlignmentType.JUSTIFIED,
                    spacing: { after: 120 }
                }));
            }
            }
        }

        const doc = new Document({
            styles: { 
                default: { 
                    document: { 
                        run: { font: "Times New Roman", size: 28 }, // 14pt = 28 half-points
                        paragraph: { spacing: { line: 276, before: 120, after: 120 } } // 1.15 interval
                    } 
                } 
            },
            sections: [{
                properties: { 
                    page: { 
                        margin: { left: 1134, right: 1134, top: 1134, bottom: 1134 } // 2cm margins
                    }
                },
                children: paragraphs
            }]
        });

        const buffer = await Packer.toBuffer(doc);
        const safeTopic = (order.topic || 'Hujjat').replace(/[^a-z0-9\s-]/gi, '_').substring(0, 50);
        const filename = `${safeTopic}_${Date.now()}.docx`;

        await updateProgress(userId, msgId, 100, "Tayyor! Fayl yuborilmoqda...");
        
        let replyOptions = { caption: "🎉 Tayyor! Marhamat.", ...getMainMenu() };
        if (order.service === 'Test yaratish') {
            const webAppUrl = getWebAppUrl();
            const link = webAppUrl ? `${webAppUrl}?userId=${userId}&v=${Date.now()}` : null;
            
            replyOptions = {
                caption: "🎉 Testlar tayyor! Marhamat yuklab oling.\n\n🌐 Yoki bevosita botning o'zida interaktiv tarzda ishlashingiz mumkin:",
                reply_markup: link ? {
                    inline_keyboard: [
                        [{ text: "🚀 Testni Boshlash (Web App)", web_app: { url: link } }]
                    ]
                } : undefined
            };
            if (!link) {
                replyOptions.caption += "\n\n⚠️ (Eslatma: Web App ulanishi kutilmoqda, bir ozdan so'ng qayta urinib ko'ring)";
            }
        } else if (order.service === 'Flashcard') {
            const webAppUrl = getWebAppUrl();
            const flashcardUrl = webAppUrl ? `${webAppUrl}/flashcard.html?userId=${userId}` : null;
            
            replyOptions = {
                caption: "🧠 Flashcardlar tayyor! Marhamat yuklab oling.\n\n🌐 Yoki bevosita botning o'zida interaktiv tarzda ko'rishingiz mumkin:",
                reply_markup: flashcardUrl ? {
                    inline_keyboard: [
                        [{ text: "🧠 Flashcardlarni Ochish (Web App)", web_app: { url: flashcardUrl } }]
                    ]
                } : undefined
            };
        }

        await bot.telegram.sendDocument(userId, { source: buffer, filename }, replyOptions);
        
        // Menyu qayta ko'rsatish (test bo'lmasa)
        if (order.service !== 'Test yaratish') {
            await bot.telegram.sendMessage(userId, "✅ Xizmat yakunlandi. Yana nima qilishni xohlaysiz?", { ...getMainMenu() }).catch(() => {});
        }

        if (msgId) bot.telegram.deleteMessage(userId, msgId).catch(() => { });

        // Adminga to'liq ma'lumot yuborish
        if (ADMIN_ID) {
            const userInfo = 
                `🤖 <b>Yangi buyurtma yakunlandi</b>\n\n` +
                `👤 Ism: <b>${order.username !== "yo'q" ? order.username : 'Noaniq'}</b>\n` +
                `🆔 ID: <code>${userId}</code>\n` +
                `🌐 Telegram: ${order.username && order.username !== "yo'q" ? '@' + order.username : 'Mavjud emas'}\n` +
                `📋 Xizmat: <b>${order.service}</b>\n` +
                `📌 Mavzu: ${order.topic || 'Ko\'rsatilmagan'}\n` +
                (order.subject ? `📚 Fan: ${order.subject}\n` : '') +
                (order.grade ? `🎓 Daraja: ${order.grade}\n` : '') +
                (order.language ? `🌐 Til: ${order.language}\n` : '');
            bot.telegram.sendMessage(ADMIN_ID, userInfo, { parse_mode: 'HTML' });
            bot.telegram.sendDocument(ADMIN_ID, { source: buffer, filename }).catch(() => { });
        }
        totalOrders++;
        ordersCache.delete(userId);
    } catch (error) {
        console.error("AI Generation Error:", error);
        const errorMsg = error.message || "";
        let userAdvice = "Iltimos, bir ozdan so'ng qayta urinib ko'ring yoki mavzu hajmini qisqartiring.";
        
        if (errorMsg.includes("limit") || errorMsg.includes("429")) {
            userAdvice = "AI tizimlarida vaqtinchalik yuklama yuqori. 5-10 daqiqadan so'ng urinib ko'ring.";
        } else if (errorMsg.includes("tokens") || errorMsg.includes("large")) {
            userAdvice = "Mavzu yoki fayl matni juda katta. Iltimos, kichikroq qismlarga bo'lib urinib ko'ring.";
        }

        const friendlyError = `⚠️ <b>Tizimda uzilish yuz berdi:</b>\n\n<code>${errorMsg.substring(0, 200)}</code>\n\n💡 <b>Tavsiya:</b> ${userAdvice}`;

        if (msgId) {
            await bot.telegram.editMessageText(userId, msgId, null, friendlyError, { 
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback("🔄 Qayta urinish", "retry_gen_" + userId)]])
            }).catch(() => {});
        } else {
            await bot.telegram.sendMessage(userId, friendlyError, { 
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback("🔄 Qayta urinish", "retry_gen_" + userId)]])
            }).catch(() => {});
        }
    }
}

// -------------------------------------------------------------
// INLINE BUTTON ACTIONS
// -------------------------------------------------------------
bot.action(/^retry_gen_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('🔄 Qaytadan urunish boshlandi!');
    const userId = parseInt(ctx.match[1]);
    const order = ordersCache.get(userId);
    if (!order) return ctx.reply("Sessiya xotirasi eskirgan. Iltimos boshidan buyurtma bering.");
    processAIGeneration(userId, order);
});

// To'lov cheki (rasm) qabul qilish
bot.on('photo', async (ctx) => {
    const payment = pendingPayments.get(ctx.from.id);
    if (payment) {
        if (!ADMIN_ID) return ctx.reply("Kechirasiz, admin bilan ulanishda xatolik.");
        
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const username = ctx.from.username ? `@${ctx.from.username}` : "yo'q";
        const caption = `💰 <b>Yangi to'lov cheki!</b>\n\n👤 Mijoz: <a href="tg://user?id=${ctx.from.id}">${ctx.from.first_name || 'Noma\'lum'}</a>\n🆔 ID: <code>${ctx.from.id}</code>\n🌐 Telegram: ${username}\n📋 Xizmat: <b>${payment.service}</b>\n\nIltimos, to'lovni tasdiqlang.`;

        await bot.telegram.sendPhoto(ADMIN_ID, photo.file_id, {
            caption,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "✅ Tasdiqlash", callback_data: `pay_ok_${ctx.from.id}` }],
                    [{ text: "❌ Rad etish", callback_data: `pay_no_${ctx.from.id}` }]
                ]
            }
        });

        // pendingPayments.delete(ctx.from.id); // Adminga yuborganda o'chirmaymiz, tasdiqlaganda o'chiramiz
        ctx.reply("✅ To'lov cheki adminga yuborildi. Iltimos, tasdiqlanishini kuting.");
    }
});

bot.action(/^pay_ok_(\d+)$/, async (ctx) => {
    const userId = parseInt(ctx.match[1]);
    const payment = pendingPayments.get(userId);
    await ctx.answerCbQuery('✅ Tasdiqlandi!');
    ctx.editMessageCaption(ctx.callbackQuery.message.caption + '\n\n✅ <b>TASDIQLANDI</b>', { parse_mode: 'HTML' }).catch(() => { });

    if (payment && payment.service === 'Jamoaviy Test') {
        const expiryTime = Date.now() + payment.duration * 60000;
        teacherSubs.set(userId, { expiryTime, isActive: true });
        savePersistentData().catch(() => {});
        bot.telegram.sendMessage(userId, 
            `✅ <b>To'lovingiz tasdiqlandi!</b>\n\n` +
            `Sizga <b>${payment.duration >= 1440 ? '24 soatlik' : payment.duration + ' daqiqalik'}</b> Jamoaviy Test yaratish imkoniyati berildi.\n\n` +
            `Hozir test yaratish uchun <b>👥 Jamoaviy Test</b> tugmasini bosing.`, 
            { parse_mode: 'HTML', ...getMainMenu() }
        ).catch(() => {});
    } else if (payment && payment.service === 'Vaqtni uzaytirish') {
        const teamQuiz = teamQuizStorage.get(payment.teamId);
        if (teamQuiz) {
            teamQuiz.expiryTime += payment.duration * 60000;
            savePersistentData().catch(() => {});
            bot.telegram.sendMessage(userId, `✅ <b>Vaqt uzaytirildi!</b>\n\nTest kodi <code>${teamQuiz.code}</code> uchun vaqt yana <b>${payment.duration} daqiqaga</b> uzaytirildi.`, { parse_mode: 'HTML' });
        } else {
            bot.telegram.sendMessage(userId, "❌ Xatolik: Test topilmadi yoki muddati tugab o'chib ketgan.");
        }
    } else {
        // Taqdimot uchun
        bot.telegram.sendMessage(userId, "✅ <b>To'lovingiz tasdiqlandi!</b>\nSiz yana taqdimot buyurtma qilishingiz mumkin.", { parse_mode: 'HTML', ...getMainMenu() })
            .then(() => {
                const curr = taqdimotLimits.get(userId) || 0;
                taqdimotLimits.set(userId, Math.max(0, curr - 1));
                saveTaqdimotLimits();
            }).catch(() => { });
    }
    pendingPayments.delete(userId);
});

bot.action(/^pay_no_(\d+)$/, async (ctx) => {
    const userId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery('❌ Rad etildi');
    ctx.editMessageCaption(ctx.callbackQuery.message.caption + '\n\n❌ RAD ETILDI').catch(() => { });
    
    bot.telegram.sendMessage(userId, "❌ <b>To'lovingiz rad etildi!</b>\nIltimos, to'lov chekini qaytadan yuboring yoki admin bilan bog'laning.", { parse_mode: 'HTML' }).catch(() => { });
    pendingPayments.delete(userId);
});


// Web App Data qabul qilish
bot.on('web_app_data', (ctx) => {
    try {
        const data = JSON.parse(ctx.message.web_app_data.data);
        if (data.action === 'quiz_completed') {
            const userName = ctx.from.first_name || "Noma'lum";
            const userId = ctx.from.id;
            
            // Foydalanuvchiga natijani yuborish
            ctx.reply(`🏆 <b>Ajoyib natija!</b>\n\nSiz jami ${data.total} ta savoldan <b>${data.score}</b> tasiga to'g'ri javob berdingiz! 🎉`, { parse_mode: 'HTML', ...getMainMenu() });
            
            // Adminga natijani yuborish
            if (process.env.ADMIN_ID) {
                bot.telegram.sendMessage(process.env.ADMIN_ID, `📊 <b>Yangi test natijasi (Web App)</b>\n\n👤 Foydalanuvchi: <a href="tg://user?id=${userId}">${userName}</a>\n🆔 ID: <code>${userId}</code>\n✅ To'g'ri javoblar: <b>${data.score}</b> ta\n❓ Jami savollar: <b>${data.total}</b> ta\n📈 Foiz: <b>${Math.round((data.score/data.total)*100)}%</b>`, { parse_mode: 'HTML' }).catch(() => {});
            }
        }
    } catch (e) {
        console.error("WebApp Data error", e);
    }
});

bot.launch().then(() => {
    console.log("Bot muvaffaqiyatli ishga tushdi!");
}).catch((err) => {
    console.error("Bot ishga tushishida xatolik:", err);
});

// Railway.app uchun Express server (Web App va ulanish uchun)
const express = require('express');
const app = express();


// JSON ma'lumotlarni o'qish uchun
app.use(express.json());

// Public papkasini statik ulash (Web App interfeysi)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/quiz/:userId', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    const userId = parseInt(req.params.userId);
    const data = quizStorage.get(userId);
    if (data) {
        res.json(data);
    } else {
        res.status(404).json({ error: "No quiz found" });
    }
});

app.get('/api/quiz/team/:teamId', (req, res) => {
    const teamId = req.params.teamId;
    console.log(`[API] Team Quiz request: ${teamId}`);
    const data = teamQuizStorage.get(teamId);
    if (data) {
        console.log(`[API] Team Quiz found: ${data.topic}`);
        res.json(data);
    } else {
        console.error(`[API] Team Quiz NOT found: ${teamId}`);
        res.status(404).json({ error: "Team quiz not found or expired" });
    }
});

// Flashcard API
app.get('/api/flashcards/:userId', (req, res) => {
    const userId = parseInt(req.params.userId);
    const data = flashcardStorage.get(userId);
    if (data) {
        res.json(data);
    } else {
        res.status(404).json({ error: "No flashcards found" });
    }
});

// Natijalarni avtomatik qabul qilish
app.post('/api/quiz-result', async (req, res) => {
    console.log("📥 [RESULT] Yangi natija keldi:", JSON.stringify(req.body));
    try {
        const { userId, teamId, score, total, name, username } = req.body;
        
        if (teamId) {
            const teamQuiz = teamQuizStorage.get(teamId);
            if (teamQuiz) {
                teamQuiz.submissions.push({ name, username, score, total, timestamp: Date.now() });
                savePersistentData();
                
                // O'qituvchiga individual natija yuborish
                const teacherMsg = `📊 <b>Jamoaviy Test: Yangi natija!</b>\n\n` +
                    `👤 O'quvchi: <b>${name}</b> (${username})\n` +
                    `✅ Ball: <b>${score}/${total}</b> (${Math.round(score/total*100)}%)\n` +
                    `📈 Umumiy: ${teamQuiz.submissions.length}/${teamQuiz.expectedStudents}`;
                
                await bot.telegram.sendMessage(teamQuiz.teacherId, teacherMsg, { parse_mode: 'HTML' }).catch(() => {});
                
                // O'qituvchi xabarini yangilash (Dashboard)
                if (teamQuiz.messageId) {
                    const remainingMs = teamQuiz.expiryTime - Date.now();
                    const minutes = Math.max(0, Math.floor(remainingMs / 60000));
                    const seconds = Math.max(0, Math.floor((remainingMs % 60000) / 1000));
                    const timerStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
                    
                    const clockEmojis = ['🕛', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚'];
                    const clock = clockEmojis[Math.floor(Date.now() / 5000) % clockEmojis.length];
                    
                    let list = teamQuiz.submissions.slice(-15).map((s, idx) => {
                        const percent = Math.round((s.score / s.total) * 100);
                        let uname = (s.username || "").toString().replace(/^@+/, '');
                        const username = uname ? `(@${esc(uname)})` : "";
                        return `✅ <b>${esc(s.name)}</b> ${username} — <b>${s.score}/${s.total}</b> (${percent}%)`;
                    }).join('\n');

                    const updateText = `📊 <b>JAMOAVIY TEST MONITORING</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n` +
                        `📌 Mavzu: <b>${esc(teamQuiz.topic)}</b>\n` +
                        `🔢 Kod: <code>${teamQuiz.code}</code>\n` +
                        `👥 Topshirdi: <b>${teamQuiz.submissions.length}/${teamQuiz.expectedStudents}</b>\n` +
                        `${clock} Qolgan vaqt: <b>${timerStr}</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `📝 <b>SO'NGGI NATIJALAR:</b>\n` +
                        `${list || '<i>Hali natijalar yo\'q...</i>'}\n\n` +
                        `✨ <i>Yangi natijalar avtomatik yangilanadi</i>`;
                    
                    const inline_keyboard = [
                        [{ text: "➕ Vaqtni uzaytirish", callback_data: "extend_time" }]
                    ];

                    await bot.telegram.editMessageText(teamQuiz.teacherId, teamQuiz.messageId, null, updateText, { 
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: inline_keyboard }
                    }).catch(err => console.error("Dashboard update error:", err));
                }

                // Agar hamma topshirgan bo'lsa, umumiy hisobot
                if (teamQuiz.submissions.length >= teamQuiz.expectedStudents) {
                    const avgScore = teamQuiz.submissions.reduce((a, b) => a + b.score, 0) / teamQuiz.submissions.length;
                    const finalReport = `🏆 <b>YAKUNIY HISOBOT</b>\n\n` +
                        `📌 Mavzu: ${teamQuiz.topic}\n` +
                        `👥 Jami o'quvchilar: ${teamQuiz.submissions.length}\n` +
                        `📊 O'rtacha natija: <b>${avgScore.toFixed(1)}/${total}</b>\n\n` +
                        `Test yakunlandi. Rahmat!`;
                    await bot.telegram.sendMessage(teamQuiz.teacherId, finalReport, { parse_mode: 'HTML' }).catch(() => {});
                }
                
                return res.json({ success: true });
            }
        }

        // Individual test natijasi (mavjud mantiq)
        if (!userId) {
            return res.status(400).json({ error: "Missing userId" });
        }

        const adminId = process.env.ADMIN_ID;
        if (adminId) {
            const text = `📊 <b>Yangi test natijasi (Avtomatik)</b>\n\n👤 Foydalanuvchi: <b>${name || 'Noma\'lum'}</b>\n🌐 Username: <b>${username || 'Mavjud emas'}</b>\n🆔 ID: <code>${userId}</code>\n✅ To'g'ri javoblar: <b>${score}</b> ta\n❓ Jami savollar: <b>${total}</b> ta\n📈 Foiz: <b>${Math.round((score/total)*100)}%</b>`;
            await bot.telegram.sendMessage(adminId, text, { parse_mode: 'HTML' }).catch(() => {});
        }

        res.json({ success: true });
    } catch (err) {
        console.error("❌ [RESULT] Xatolik:", err);
        res.status(500).json({ error: "Server error" });
    }
});

app.get('/', (req, res) => {
    if (req.query.teamId) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        res.sendFile(path.join(__dirname, 'public', 'landing.html'));
    }
});

const { spawn, exec } = require('child_process');
const localtunnel = require('localtunnel');
const PORT = process.env.PORT || 3000;

let currentTunnelProvider = 0; // 0: pinggy (PRIMARY), 1: localtunnel, 2: localhost.run
let tunnelProcess = null;

async function startTunnel() {
    const providers = [
        async () => {
            console.log("[TUNNEL] Provider: Pinggy...");
            const ssh = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-p', '443', '-R', `0:localhost:${PORT}`, 'a.pinggy.io']);
            let urlFound = false;
            ssh.stdout.on('data', (data) => {
                const out = data.toString();
                const match = out.match(/https:\/\/[a-zA-Z0-9.-]+\.a\.pinggy\.link/);
                if (match && !urlFound) {
                    urlFound = true;
                    process.env.WEB_APP_URL = match[0];
                    console.log(`[TUNNEL] Web App HTTPS manzil tayyor: ${match[0]}`);
                    if (process.env.ADMIN_ID) {
                        bot.telegram.sendMessage(process.env.ADMIN_ID, `🌐 <b>Yangi Web App havolasi (Pinggy) tayyor:</b>\n${match[0]}`, { parse_mode: 'HTML' }).catch(() => {});
                    }
                    updateAllActiveDashboards();
                }
            });
            ssh.stderr.on('data', (data) => {
                const errOut = data.toString();
                if (errOut.includes("permission denied")) {
                    console.log("[PINGGY] Permission error, switching provider...");
                    switchProvider();
                }
            });
            ssh.on('close', () => { if(!urlFound) setTimeout(startTunnel, 5000); });
            return ssh;
        },
        async () => {
            console.log("[TUNNEL] Provider: Localtunnel...");
            try {
                const subdomain = `bytebot-${Math.random().toString(36).substr(2, 5)}`;
                const tunnel = await localtunnel({ port: PORT, subdomain });
                process.env.WEB_APP_URL = tunnel.url;
                console.log(`[TUNNEL] Web App HTTPS manzil tayyor: ${tunnel.url}`);
                if (process.env.ADMIN_ID) {
                    bot.telegram.sendMessage(process.env.ADMIN_ID, `🌐 <b>Yangi Web App havolasi (Localtunnel) tayyor:</b>\n${tunnel.url}\n\n⚠️ <i>Eslatma: Agar 'Caution' oynasi chiqsa, o'sha yerdagi IP-ni kiriting.</i>`, { parse_mode: 'HTML' }).catch(() => {});
                }
                updateAllActiveDashboards();
                tunnel.on('close', () => { setTimeout(startTunnel, 5000); });
                return tunnel;
            } catch (e) { throw e; }
        },
        async () => {
            console.log("[TUNNEL] Provider: Localhost.run...");
            const ssh = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-R', `80:localhost:${PORT}`, 'nokey@localhost.run']);
            let urlFound = false;
            ssh.stdout.on('data', (data) => {
                const out = data.toString();
                const match = out.match(/https:\/\/[a-zA-Z0-9.-]+\.lhr\.life/);
                if (match && !urlFound) {
                    urlFound = true;
                    process.env.WEB_APP_URL = match[0];
                    console.log(`[TUNNEL] Web App HTTPS manzil tayyor: ${match[0]}`);
                    if (process.env.ADMIN_ID) {
                        bot.telegram.sendMessage(process.env.ADMIN_ID, `🌐 <b>Yangi Web App havolasi (Localhost.run) tayyor:</b>\n${match[0]}`, { parse_mode: 'HTML' }).catch(() => {});
                    }
                }
            });
            ssh.on('close', () => { if(!urlFound) setTimeout(startTunnel, 5000); });
            return ssh;
        }
    ];

    try {
        clearTimeout(global.tunnelTimeout);
        global.tunnelTimeout = setTimeout(() => {
            if (!process.env.WEB_APP_URL) {
                console.log(`[TUNNEL] Provider ${currentTunnelProvider} URL ololmadi (timeout). Switcher ishga tushdi.`);
                switchProvider();
            }
        }, 15000); // 15 soniya kutish

        tunnelProcess = await providers[currentTunnelProvider]();
        console.log(`[TUNNEL] Ulanishga urinish tugadi: ${currentTunnelProvider}`);
    } catch (err) {
        console.error(`[TUNNEL] Provider ${currentTunnelProvider} xatosi:`, err.message);
        switchProvider();
    }
}

function switchProvider() {
    currentTunnelProvider = (currentTunnelProvider + 1) % 3;
    console.log(`[TUNNEL] Boshqa providerga o'tilmoqda: ${currentTunnelProvider}...`);
    if (process.platform === 'win32') exec('taskkill /F /IM ssh.exe');
    else exec('pkill ssh');
    setTimeout(startTunnel, 2000);
}

// Health check - yanada tezkor (30 soniya)
setInterval(() => {
    if (process.env.WEB_APP_URL) {
        const https = require('https');
        https.get(process.env.WEB_APP_URL, (res) => {
            if (res.statusCode >= 500 || res.statusCode === 404) {
                console.log(`[HEALTH] Tunnel xatosi (${res.statusCode}). Switcher ishga tushdi.`);
                switchProvider();
            }
        }).on('error', () => {
            console.log("[HEALTH] Ulanishda xato. Switcher ishga tushdi.");
            switchProvider();
        });
    }
}, 30000);

const server = app.listen(PORT, () => {
    console.log(`Express server portda ishga tushdi: ${PORT}`);
    if (!process.env.WEB_APP_URL) startTunnel();
});

// Jonli timer uchun har 10 soniyada dashboardlarni yangilash
setInterval(() => {
    updateAllActiveDashboards();
}, 10000);

// Tunnel yopilib qolmasligi uchun har 30 soniyada ping yuboramiz
setInterval(() => {
    if (process.env.WEB_APP_URL) {
        const https = require('https');
        https.get(process.env.WEB_APP_URL, () => {}).on('error', () => {});
    }
}, 30000);

// Graceful stop
process.once('SIGINT', () => { bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); server.close(); });

// Dastur doirasidan tashqarida paydo bo'lgan xatoliklar botni o'chirib qo'ymasligi uchun
process.on('uncaughtException', (err) => {
    console.error('Kutilmagan xatolik yuz berdi:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Hal qilinmagan xatolik:', reason);
});
