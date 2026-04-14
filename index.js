require('dotenv').config();
const { Telegraf, session, Scenes, Markup } = require('telegraf');
const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;
const CARD_NUMBER = process.env.CARD_NUMBER || '8600 0000 0000 0000';
const CARD_OWNER = process.env.CARD_OWNER || 'Admin';
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const GROQ_API_KEY = process.env.GROQ_API_KEY || null;

// Progress Bar Helper
const getProgressBar = (p) => {
    const total = 10;
    const filled = Math.round((p / 100) * total);
    return "▓".repeat(filled) + "░".repeat(total - filled) + ` ${p}%`;
};

async function updateProgress(userId, messageId, percent, status) {
    const text = `⏳ <b>Tayyorlanmoqda...</b>\n\n${getProgressBar(percent)}\n\n💠 ${status}`;
    return bot.telegram.editMessageText(userId, messageId, null, text, { parse_mode: 'HTML' }).catch(() => {});
}

// Caches & Stats
const pendingPayments = new Map(); 
const ordersCache = new Map(); 
let uniqueUsers = new Set();
let totalOrders = 0;

// Foydalanuvchilarni sanash uchun middleware
bot.use((ctx, next) => {
    console.log("Yangi update keldi:", ctx.updateType);
    if (ctx.from) {
        uniqueUsers.add(ctx.from.id);
    }
    return next();
});

bot.catch((err, ctx) => {
    console.error(`Xato yuz berdi (${ctx.updateType}):`, err);
});

// Buyurtma uchun Wizard Scene
const homeworkWizard = new Scenes.WizardScene(
    'homeworkWizard',
    (ctx) => {
        ctx.scene.session.order = { service: 'Mustaqil ish yozib berish' };
        ctx.reply("Assalomu alaykum! Ism familiyangizni va telefon raqamingizni kiriting:\n(Masalan: Otabek +998901234567)", Markup.removeKeyboard());
        return ctx.wizard.next();
    },
    (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, ma'lumotlarni kiriting:");
        const text = ctx.message.text;
        ctx.scene.session.order.name = text.replace(/[\d+]/g, '').trim() || "Mijoz";
        ctx.scene.session.order.phone = text.match(/[\d+]+/g)?.join('') || "Kiritilmadi";
        
        ctx.reply("Mustaqil ish qaysi fan doirasida yoziladi? (Masalan: Falsafa, Tarix, Fizika)");
        return ctx.wizard.next();
    },
    (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, fan nomini yozing:");
        ctx.scene.session.order.subject = ctx.message.text;
        ctx.reply("Qaysi fakultetda o'qiysiz? (Masalan: Axborot texnologiyalari, Iqtisodiyot)");
        return ctx.wizard.next();
    },
    (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply("Fakultet nomini kiriting:");
        ctx.scene.session.order.faculty = ctx.message.text;
        ctx.reply("Mustaqil ish uchun mavzuni kiriting:");
        return ctx.wizard.next();
    },
    (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, mavzuni kiriting:");
        ctx.scene.session.order.topic = ctx.message.text;
        ctx.reply("Ish qaysi tilda yozilsin?", Markup.keyboard([
            ["🇺🇿 O'zbek (lotin)", "🇷🇺 Rus"],
            ["🇬🇧 Ingliz", "Ўзбек (кирилл)"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, ishchi tilini tanlang:");
        ctx.scene.session.order.language = ctx.message.text;
        ctx.reply("Hajmi qancha bo'lishi kerak?", Markup.keyboard([
            ["5-10 bet", "10-15 bet"],
            ["15-20 bet"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, hajmini tanlang:");
        const pages = ctx.message.text;
        ctx.scene.session.order.pages = pages;
        
        let price = "15 000";
        if (pages === "10-15 bet") price = "25 000";
        if (pages === "15-20 bet") price = "35 000";
        ctx.scene.session.order.price = price;

        const order = ctx.scene.session.order;
        const cachedOrder = {
            ...order,
            userId: ctx.from.id,
            username: ctx.from.username || "yo'q",
            authorName: `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || 'Hurmatli Talaba'
        };
        
        pendingPayments.set(ctx.from.id, cachedOrder);
        
        await ctx.reply(
            `💳 <b>To'lov ma'lumotlari</b>\n\n` +
            `💰 To'lov miqdori: <b>${price} so'm</b>\n` +
            `🏦 Karta: <code>${CARD_NUMBER}</code>\n` +
            `👤 Qabul qiluvchi: ${CARD_OWNER}\n\n` +
            `Iltimos, to'lovni amalga oshiring va tasdiq uchun skrinshotni yuboring.`,
            { parse_mode: 'HTML', ...Markup.removeKeyboard() }
        );
        return ctx.scene.leave();
    }
);

const articleWizard = new Scenes.WizardScene(
    'articleWizard',
    (ctx) => {
        ctx.scene.session.order = { service: 'Maqola yozib berish' };
        ctx.reply("Assalomu alaykum! Maqola buyurtmasi uchun ma'lumotlaringizni kiriting:\n(Masalan: Otabek +998901234567)", Markup.removeKeyboard());
        return ctx.wizard.next();
    },
    (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, ma'lumotlarni kiriting:");
        const text = ctx.message.text;
        ctx.scene.session.order.name = text.replace(/[\d+]/g, '').trim() || "Mijoz";
        ctx.scene.session.order.phone = text.match(/[\d+]+/g)?.join('') || "Kiritilmadi";
        ctx.reply("Maqola uchun mavzuni kiriting:");
        return ctx.wizard.next();
    },
    (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, mavzuni kiriting:");
        ctx.scene.session.order.topic = ctx.message.text;
        ctx.reply("Maqola uslubini tanlang:", Markup.keyboard([
            ["Ommabop (Popular)", "Ilmiy (Scientific)"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, uslubni tanlang:");
        ctx.scene.session.order.style = ctx.message.text;
        
        if (ctx.message.text === 'Ilmiy (Scientific)') {
            ctx.reply("Ish joyingiz va tadqiqot maskaningizni yozing:\n(Masalan: Toshkent Davlat Texnika Universiteti)");
            return ctx.wizard.next();
        } else {
            // Skip scientific-only fields
            ctx.scene.session.order.institution = 'Ko\'rsatilmadi';
            ctx.scene.session.order.position = 'Muallif';
            ctx.scene.session.order.email = 'Ko\'rsatilmadi';
            ctx.wizard.selectStep(7); // Absolute index in wizard.steps
            return ctx.wizard.steps[7](ctx);
        }
    },
    (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, ish joyingizni yozing:");
        ctx.scene.session.order.institution = ctx.message.text;
        ctx.reply("Ilmiy unvoningiz yoki lavozimingizni yozing:\n(Masalan: Dotsent, tayanch doktorant)");
        return ctx.wizard.next();
    },
    (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, unvoningizni yozing:");
        ctx.scene.session.order.position = ctx.message.text;
        ctx.reply("Elektron pochta manzilingizni yozing:");
        return ctx.wizard.next();
    },
    (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, pochtangizni yozing:");
        ctx.scene.session.order.email = ctx.message.text;
        ctx.reply("Ilmiy rahbaringiz bormi? (F.I.SH., unvoni, email).\nYo'q bo'lsa 'Yo'q' deb yozing:");
        return ctx.wizard.next();
    },
    (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, ma'lumotni kiriting yoki 'Yo'q' deb yozing:");
        ctx.scene.session.order.advisor = ctx.message.text.toLowerCase() === 'yo\'q' ? null : ctx.message.text;
        ctx.reply("Matn qaysi tilda yozilsin?", Markup.keyboard([
            ["🇺🇿 O'zbek (lotin)", "🇷🇺 Rus"],
            ["🇬🇧 Ingliz", "Ўзбек (кирилл)"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, tilni tanlang:");
        ctx.scene.session.order.language = ctx.message.text;
        ctx.reply("Hajmi qancha bo'lishi kerak?", Markup.keyboard([
            ["3-5 bet", "5-8 bet"],
            ["8-10 bet"]
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply("Iltimos, hajmini tanlang:");
        const pages = ctx.message.text;
        ctx.scene.session.order.pages = pages;
        
        let price = "40 000";
        if (pages === "5-8 bet") price = "60 000";
        if (pages === "8-10 bet") price = "80 000";
        ctx.scene.session.order.price = price;

        const order = ctx.scene.session.order;
        const cachedOrder = {
            ...order,
            userId: ctx.from.id,
            username: ctx.from.username || "yo'q",
            authorName: `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || 'Hurmatli Muallif'
        };
        pendingPayments.set(ctx.from.id, cachedOrder);
        
        await ctx.reply(
            `💳 <b>To'lov ma'lumotlari (Maqola)</b>\n\n` +
            `💰 To'lov miqdori: <b>${price} so'm</b>\n` +
            `🏦 Karta: <code>${CARD_NUMBER}</code>\n` +
            `👤 Qabul qiluvchi: ${CARD_OWNER}\n\n` +
            `Iltimos, to'lovni amalga oshiring va tasdiq uchun skrinshotni yuboring.`,
            { parse_mode: 'HTML', ...Markup.removeKeyboard() }
        );
        return ctx.scene.leave();
    }
);

const stage = new Scenes.Stage([homeworkWizard, articleWizard]);
bot.use(session());
bot.use(stage.middleware());

// Asosiy menyu
function getMainMenu() {
    return Markup.keyboard([
        ["📚 Mustaqil ish", "📝 Maqola"],
        ['Xizmatlarimiz', 'Narxlar'],
        ['Bog\'lanish', 'Savollar']
    ]).resize();
}

// -------------------------------------------------------------
// BOT COMMANDS & MESSAGE HANDLERS
// -------------------------------------------------------------
bot.start((ctx) => {
    uniqueUsers.add(ctx.from.id);
    ctx.reply(
        "👋 Assalomu alaykum! Sifatli AI xizmatlariga xush kelibsiz.\nQuyidagi menyudan xizmat turini tanlang:", 
        getMainMenu()
    );
});

bot.hears("📚 Mustaqil ish", (ctx) => {
    uniqueUsers.add(ctx.from.id);
    ctx.scene.enter('homeworkWizard');
});

bot.hears("📝 Maqola", (ctx) => {
    uniqueUsers.add(ctx.from.id);
    ctx.scene.enter('articleWizard');
});

bot.command('admin', (ctx) => {
    if (ctx.from.id.toString() === ADMIN_ID) {
        ctx.reply(`📊 <b>Bot Statistikasi:</b>\n\n👥 Botdan foydalanganlar: ${uniqueUsers.size}\n🛍 Jami buyurtmalar: ${totalOrders}`, { parse_mode: 'HTML' });
    } else {
        ctx.reply("Sizda admin huquqi yo'q.");
    }
});

bot.hears('Xizmatlarimiz', (ctx) => {
    ctx.reply("Bizning xizmatlarimiz:", Markup.inlineKeyboard([
        [Markup.button.callback('🤖 Telegram bot yasash', 'service_bot')],
        [Markup.button.callback('🌐 Veb-sayt yasash', 'service_web')],
        [Markup.button.callback('📈 SMM xizmati', 'service_smm')]
    ]));
});

bot.hears("Narxlar", (ctx) => {
    ctx.reply("💰 <b>Tahminiy narxlarimiz (hajmiga qarab):</b>\n\n" +
        "📚 <b>Mustaqil ish (Super narxlar!):</b>\n" +
        " - 5-10 bet: 15 000 so'm\n" +
        " - 10-15 bet: 25 000 so'm\n" +
        " - 15-20 bet: 35 000 so'm\n\n" +
        "📝 <b>Maqola:</b>\n" +
        " - 3-5 bet: 40 000 so'm\n" +
        " - 5-8 bet: 60 000 so'm\n" +
        " - 8-10 bet: 80 000 so'm\n\n" +
        "🤖 Telegram bot: 100$ dan boshlab\n" +
        "🌐 Veb-sayt: 300$ dan boshlab", { parse_mode: 'HTML' });
});

bot.hears("Bog'lanish", (ctx) => {
    ctx.reply("Admin: @dil_parvozi");
});

bot.hears("Savollar", (ctx) => {
    ctx.reply("❓ Ko'p beriladigan savollar...\nTo'lov oldindan amalga oshiriladi.");
});

bot.command('cancel', (ctx) => {
    ctx.reply("Buyurtma bekor qilindi.", getMainMenu());
    ctx.scene.leave();
});

// Photo & Screenshot receiving
bot.on('photo', async (ctx) => {
    const userId = ctx.from.id;
    if (pendingPayments.has(userId)) {
        const order = pendingPayments.get(userId);
        const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        
        ordersCache.set(userId, order);
        pendingPayments.delete(userId);
        
        await ctx.reply("⏳ Skrinshot qabul qilindi. Adminga yuborildi, kuting...", getMainMenu());
        totalOrders++;
        
        if (ADMIN_ID) {
            const orderInfo =
                `📝 <b>TO'LOV CHEKI (XIZMAT: ${order.service})</b>\n\n` +
                `💰 Narxi: <b>${order.price} so'm</b>\n` +
                `👤 Ism: ${order.name}\n` +
                `📞 Telefon: ${order.phone}\n` +
                (order.subject ? `🎓 Fan: ${order.subject}\n` : '') +
                (order.faculty ? `🏫 Fakultet: ${order.faculty}\n` : '') +
                `📌 Mavzu: ${order.topic}\n` +
                (order.style ? `🎨 Uslub: ${order.style}\n` : '') +
                `🌐 Til: ${order.language}\n` +
                `📄 Hajmi: ${order.pages}\n` +
                `🔗 Username: @${order.username}`;
                
            bot.telegram.sendPhoto(ADMIN_ID, fileId, {
                caption: orderInfo,
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback("✅ Tasdiqlash", `pay_ok_${userId}`)],
                    [Markup.button.callback("❌ Rad etish", `pay_no_${userId}`)]
                ])
            }).catch(e => console.error(e));
        }
    }
});

// -------------------------------------------------------------
// CORE AI GENERATION HELPERS
// -------------------------------------------------------------
async function callAI(prompt, systemPrompt = "Siz akademik ekspert va yozuvchisiz.") {
    const aiErrors = [];
    
    // 1. Groq Cloud
    if (process.env.GROQ_API_KEY) {
        try {
            const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: "llama-3.3-70b-versatile",
                    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }],
                    temperature: 0.6,
                    max_tokens: 8000
                })
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
            } else {
                const err = await resp.json().catch(() => ({}));
                aiErrors.push(`Groq: ${err.error?.message || resp.status}`);
            }
        } catch (e) { aiErrors.push(`Groq Error: ${e.message}`); }
    }

    // 2. Google Gemini (Switching to V1 Stable)
    if (process.env.GEMINI_API_KEY) {
        try {
            const resp = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: `${systemPrompt}\n\n${prompt}` }] }]
                })
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data.candidates?.[0]?.content?.parts?.[0]?.text) return data.candidates[0].content.parts[0].text;
            } else {
                const err = await resp.json().catch(() => ({}));
                aiErrors.push(`Gemini: ${err.error?.message || resp.status}`);
            }
        } catch (e) { aiErrors.push(`Gemini Error: ${e.message}`); }
    }

    // 3. OpenRouter (DeepSeek)
    if (process.env.OPENROUTER_API_KEY) {
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
                    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }]
                })
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
            } else {
                const err = await resp.json().catch(() => ({}));
                aiErrors.push(`OpenRouter: ${err.error?.message || resp.status}`);
            }
        } catch (e) { aiErrors.push(`OpenRouter Error: ${e.message}`); }
    }

    // 4. Anthropic Claude (Fallback)
    if (process.env.ANTHROPIC_API_KEY) {
        try {
            const Anthropic = require('@anthropic-ai/sdk');
            const cl = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const msg = await cl.messages.create({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: 4000,
                messages: [{ role: "user", content: `${systemPrompt}\n\n${prompt}` }]
            });
            if (msg.content?.[0]?.text) return msg.content[0].text;
        } catch (e) { aiErrors.push(`Claude: ${e.message}`); }
    }

    throw new Error(aiErrors.join(" | ") || "Barcha AI tizimlari band.");
}

async function processAIGeneration(userId, order, existingMsgId = null) {
    let msgId = existingMsgId;
    if (!msgId) {
        const progMsg = await bot.telegram.sendMessage(userId, `⏳ <b>Tayyorlanmoqda...</b>\n\n${getProgressBar(10)}\n\n💠 Mavzu tahlil qilinmoqda...`, { parse_mode: 'HTML' }).catch(()=>{});
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
        const targetWords = order.service === 'Maqola yozib berish' && order.style === 'Ilmiy (Scientific)' 
            ? pCount * 450 
            : pCount * 500; // Increased volume for popular/independent work

        let prompt = "";
        if (order.service === 'Maqola yozib berish') {
            if (order.style === 'Ilmiy (Scientific)') {
                prompt = `Siz professional olim va ilmiy jurnal muharririsiz. Menga xalqaro standartlarga mos ilmiy maqola yozib bering.
- Mavzu: ${order.topic}
- Muallif: ${order.authorName} (${order.institution}, ${order.position}, ${order.email})
- Ilmiy rahbar: ${order.advisor || 'Ma\'lumot berilmagan'}
- Til: ${order.language}

MAQOLA STRUKTURASI (11pt):
1. METADATA BLOKLARI (3 tilda: O'zbek, Rus, Ingliz):
   - SHU TILDAGI SARLAVHA (KATTA HARFLARDA)
   - ANNOTATSIYA: (150-200 so'zlik mazmun)
   - KALIT SO'ZLAR: (8-12 ta so'z)

2. ASOSIY QISM:
   - KIRISH
   - TADQIQOT METODOLOGIYASI
   - NATIJA VA MUHOKAMA
   - XULOSA.
   - ADABIYOTLAR RO'YXATI

TALABLAR:
- Maqola hajmi kamida ${targetWords} so'z bo'lishi SHART.
- Hech qanday meta-izohlar, chiziqlar qo'shmang.`;
            } else {
                prompt = `Siz professional jurnalist va publitsistsiz. Menga quyidagi ma'lumotlar asosida ommabop maqola yozib bering:
- Mavzu: ${order.topic}
- Til: ${order.language}

MAQOLA STRUKTURASI:
1. JALB QILUVCHI SARLAVHA.
2. MAVZU HAQIDA CHUQUR MULOHAZA VA TAHLILIY MATN. (Hech qanday bo'limlarga, kichik sarlavhalarga bo'lmang! Matn bitta yaxlit, chuqur tahliliy oqimda bo'lishi shart).

TALABLAR:
- Jami hajm kamida ${targetWords} so'z bo'lishi shart. Bu juda muhim! Matnni o'ta batafsil va chuqur yozing.
- Matn tushunarli, qiziqarli, ILMIY-OMMABOP va ravon bo'lishi shart.`;
            }
        } else {
            prompt = `Siz malakali o'qituvchi va professor darajasidagi yozuvchisiz. Menga quyidagi ma'lumotlar asosida oliy ta'lim darajasidagi mustaqil ish yozib bering:
- Fan: ${order.subject}
- Fakultet: ${order.faculty || ''}
- Mavzu: ${order.topic}
- Til: ${order.language}

STRUKTURA:
1. REJA
2. KIRISH
3. ASOSIY QISMLAR (Kamida 4 ta bob)
4. XULOSA

TALABLAR:
- Jami matn uzunligi kamida ${targetWords} so'zdan iborat bo'lishi SHART.
- Ma'lumotlarni qisqartirmang, har bir bobni o'ta to'liq yozing.`;
        }

        await updateProgress(userId, msgId, 30, "Mavzu strukturasi tuzilmoqda...");

        if (order.pages && (parseInt(order.pages) || 5) > 5) {
            // MULTI-STAGE GENERATION (For high page counts)
            const isScientific = order.service === 'Maqola yozib berish' && order.style === 'Ilmiy (Scientific)';
            
            if (isScientific) {
                await updateProgress(userId, msgId, 40, "1-qism: Metadata va Kirish yozilmoqda...");
                const stage1Prompt = `${prompt}\n\nVazifa: Faqat METADATA BLOKLARI va KIRISH qismini yozing.`;
                const stage1 = await callAI(stage1Prompt);
                responseText += stage1 + "\n\n";

                await updateProgress(userId, msgId, 60, "2-qism: Asosiy tadqiqot qismi yozilmoqda...");
                const stage2Prompt = `Avvalgi qism:\n${stage1.substring(0, 1000)}...\n\nVazifa: TADQIQOT METODOLOGIYA VA NATIJALAR qismlarini o'ta batafsil yozing.`;
                const stage2 = await callAI(stage2Prompt);
                responseText += stage2 + "\n\n";

                await updateProgress(userId, msgId, 85, "3-qism: Xulosa va Adabiyotlar yozilmoqda...");
                const stage3Prompt = `Avvalgi qism:\n${stage2.substring(0, 1000)}...\n\nVazifa: MUHOKAMA, XULOSA va ADABIYOTLAR RO'YXATI qismlarini yozing.`;
                const stage3 = await callAI(stage3Prompt);
                responseText += stage3;
            } else {
                // Narrative/Plan Chunking for Popular/Independent
                const isIndependent = order.service === 'Mustaqil ish yozib berish';
                const stagesCount = 5; 
                for (let i = 1; i <= stagesCount; i++) {
                    const progressVal = 40 + (i * 10);
                    await updateProgress(userId, msgId, progressVal, `${i}-qism yozilmoqda...`);
                    
                    let stagePrompt = "";
                    if (isIndependent) {
                        // Plan-based Expert Stages for Mustaqil ish
                        const expertInstr = "Siz ushbu soha ekspertisiz. Har bir gapni o'ta chuqur tahlil, statistikalar va ilmiy misollar bilan boyitib yozing. Matn hajmi (betlar soni) mijoz uchun hayotiy muhim, shuning uchun hechni qisqartirmang!";
                        if (i === 1) stagePrompt = `${prompt}\n\nVazifa: ${expertInstr}\nREJA va KIRISH qismini yozing. Mavzu nomini qayta yozmang!`;
                        else if (i === 2) stagePrompt = `Avvalgi qismlar:\n${responseText.substring(Math.max(0, responseText.length - 1000))}...\n\nVazifa: ${expertInstr}\nMustaqil ishning 1-BOB qismini o'ta batafsil va ilmiy tarzda yozing.`;
                        else if (i === 3) stagePrompt = `Avvalgi qismlar:\n${responseText.substring(Math.max(0, responseText.length - 1000))}...\n\nVazifa: ${expertInstr}\n2-BOB qismini o'ta batafsil va misollar bilan yozing.`;
                        else if (i === 4) stagePrompt = `Avvalgi qismlar:\n${responseText.substring(Math.max(0, responseText.length - 1000))}...\n\nVazifa: ${expertInstr}\n3-BOB qismini o'ta batafsil va ilmiy xulosalar bilan yozing.`;
                        else stagePrompt = `Avvalgi qismlar:\n${responseText.substring(Math.max(0, responseText.length - 1000))}...\n\nVazifa: ${expertInstr}\n4-BOB, XULOSA va ADABIYOTLAR RO'YXATI qismlarini yozing. Matnni hajm jihatidan maksimal darajaga yetkazib yakunlang.`;
                    } else {
                        // Narrative for Popular
                        if (i === 1) stagePrompt = `${prompt}\n\nVazifa: Matnning boshlang'ich qismini (taxminan 20%) yozing. Sarlavhadan boshlang. Bo'limlarga bo'lmang!`;
                        else if (i === stagesCount) stagePrompt = `Avvalgi qism:\n${responseText.substring(Math.max(0, responseText.length - 1000))}...\n\nVazifa: Matnni yakunlovchi qismini yozing (oxirgi 20%). Bo'limlarga bo'lmang!`;
                        else stagePrompt = `Avvalgi qism:\n${responseText.substring(Math.max(0, responseText.length - 1000))}...\n\nVazifa: Matnni chuqur tahliliy tarzda davom ettiring (keyingi 20%). Bo'limlarga bo'lmang!`;
                    }
                    
                    const chunk = await callAI(stagePrompt);
                    responseText += (i === 1 ? "" : "\n\n") + chunk;
                }
            }
        } else {
            // SINGLE STAGE (For small orders)
            responseText = await callAI(prompt);
        }

        if (!responseText) throw new Error("No AI responded.");

        await updateProgress(userId, msgId, 80, "Word hujjat shakllantirilmoqda...");

        const currentYear = new Date().getFullYear();
        let paragraphs = [];

        if (order.service === 'Maqola yozib berish') {
            if (order.style === 'Ilmiy (Scientific)') {
                // Professional ixcham muallif bloki (11pt - o'ng tomon)
                paragraphs = [
                    new Paragraph({
                        children: [new TextRun({ text: order.authorName, bold: true, size: 22 })],
                        alignment: AlignmentType.RIGHT,
                    }),
                    new Paragraph({
                        children: [new TextRun({ text: order.institution, size: 22 })],
                        alignment: AlignmentType.RIGHT,
                    }),
                    new Paragraph({
                        children: [new TextRun({ text: order.position, size: 22 })],
                        alignment: AlignmentType.RIGHT,
                    }),
                    new Paragraph({
                        children: [new TextRun({ text: order.email, size: 22, italics: true })],
                        alignment: AlignmentType.RIGHT,
                        spacing: { after: 240 }
                    })
                ];

                if (order.advisor) {
                    paragraphs.push(new Paragraph({
                        children: [new TextRun({ text: `Ilmiy rahbar: ${order.advisor}`, size: 22, bold: true })],
                        alignment: AlignmentType.RIGHT,
                        spacing: { after: 480 }
                    }));
                }
            } else {
                // Ommabop maqola uchun ixcham header (Muallif chapda, Sarlavha o'rtada katti qora)
                paragraphs = [
                    new Paragraph({
                        children: [new TextRun({ text: `MUALLIF: ${order.authorName || 'Muallif'}`, bold: true, size: 22 })],
                        alignment: AlignmentType.LEFT,
                        spacing: { before: 200, after: 400 }
                    }),
                    new Paragraph({
                        children: [new TextRun({ text: order.topic.toUpperCase(), bold: true, size: 44 })],
                        alignment: AlignmentType.CENTER,
                        spacing: { after: 800 }
                    })
                ];
            }
        } else {
            // Mustaqil ish uchun akademik muqova
            paragraphs = [
                new Paragraph({
                    children: [new TextRun({ text: "O'ZBEKISTON RESPUBLIKASI OLIY TA'LIM, FAN VA INNOVATSIYALAR VAZIRLIGI", bold: true, size: 28 })],
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 400 }
                }),
                new Paragraph({
                    children: [new TextRun({ text: `${(order.faculty || '').toUpperCase()} FAKULTETI`, bold: true, size: 28 })],
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 400 }
                }),
                new Paragraph({
                    children: [new TextRun({ text: `"${(order.subject || '').toUpperCase()}"`, bold: true, size: 32 })],
                    alignment: AlignmentType.CENTER,
                    spacing: { before: 1400, after: 200 }
                }),
                new Paragraph({
                    children: [new TextRun({ text: "fanidan", size: 28 })],
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 400 }
                }),
                new Paragraph({
                    children: [new TextRun({ text: (order.topic || '').toUpperCase() || 'MUSTAQIL ISH MAVZUSI', bold: true, size: 36 })],
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 200 }
                }),
                new Paragraph({
                    children: [new TextRun({ text: "mavzusida", size: 28 })],
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 400 }
                }),
                new Paragraph({
                    children: [new TextRun({ text: "MUSTAQIL ISH", bold: true, size: 56 })],
                    alignment: AlignmentType.CENTER,
                    spacing: { before: 400, after: 1200 }
                }),
                new Paragraph({
                    children: [new TextRun({ text: `Bajardi: ${order.authorName || 'Talaba'}`, bold: true, size: 28 })],
                    alignment: AlignmentType.RIGHT,
                    spacing: { after: 200 }
                }),
                new Paragraph({
                    children: [new TextRun({ text: `Qabul qildi: _________________`, bold: true, size: 28 })],
                    alignment: AlignmentType.RIGHT,
                    spacing: { after: 1400 }
                }),
                new Paragraph({
                    children: [new TextRun({ text: `Toshkent - ${currentYear}`, bold: true, size: 24 })],
                    alignment: AlignmentType.CENTER,
                }),
                new Paragraph({ text: "", pageBreakBefore: true })
            ];
        }

        const isScientificMaqola = order.service === 'Maqola yozib berish' && order.style === 'Ilmiy (Scientific)';
        const lines = responseText.split('\n');
        for (let line of lines) {
            let cleanLine = line.trim();
            if (cleanLine === '') continue;
            let isHeading = cleanLine.startsWith('#');
            cleanLine = cleanLine.replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/\*/g, '');
            const upperLine = cleanLine.toUpperCase();
            const scientificHeadings = [
                'REJA:', 'REJA', 'KIRISH', 'XULOSA', 'TEZIS', 'METODLAR', 'NATIJALAR', 'MUHOKAMA', 
                'TADQIQOT METODOLOGIYASI', 'NATIJA VA MUHOKAMA', 'ADABIYOTLAR RO\'YXATI'
            ];
            
            const metadataLabels = ['ANNOTATSIYA:', 'ABSTRACT:', 'АННОТАЦИЯ:', 'KALIT SO\'ZLAR:', 'KEYWORDS:', 'КЛЮЧЕВЫЕ СЛОВА:'];

            let isLabelPara = metadataLabels.some(l => upperLine.startsWith(l));
            let isScientificTitle = isScientificMaqola && paragraphs.length < 25 && upperLine === cleanLine && cleanLine.length > 5;
            
            const isPopular = order.style === 'Ommabop (Popular)';
            const isIndependent = order.service === 'Mustaqil ish yozib berish';
            const isHeaderAllowed = isHeading || (scientificHeadings.some(h => upperLine.includes(h)) || isScientificTitle);

            // Set correct font small/big based on style
            let fontSize = 22;
            if (isPopular) fontSize = 28;
            if (isIndependent) fontSize = 24;

            // Re-add centered title on 2nd page (Mustaqil ish)
            if (paragraphs.length === 16 && isIndependent) {
                paragraphs.push(new Paragraph({
                    children: [new TextRun({ text: (order.topic || '').toUpperCase(), bold: true, size: 30 })],
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 400 }
                }));
            }

            if (isHeaderAllowed && !isLabelPara && !isPopular) {
                paragraphs.push(new Paragraph({
                    children: [new TextRun({ text: cleanLine, bold: true, size: fontSize })],
                    alignment: AlignmentType.LEFT,
                    spacing: { before: 240, after: 120 }
                }));
            } else if (isLabelPara) {
                // Split bold label from normal text
                const colonIndex = cleanLine.indexOf(':');
                const label = cleanLine.substring(0, colonIndex + 1);
                const content = cleanLine.substring(colonIndex + 1);
                paragraphs.push(new Paragraph({
                    children: [
                        new TextRun({ text: label, bold: true, size: fontSize }),
                        new TextRun({ text: content, size: fontSize })
                    ],
                    alignment: AlignmentType.LEFT,
                    spacing: { after: 120 }
                }));
            } else {
                paragraphs.push(new Paragraph({
                    children: [new TextRun({ text: cleanLine, size: fontSize })],
                    alignment: AlignmentType.LEFT,
                    spacing: { after: 120 }
                }));
            }
        }

        const doc = new Document({
            styles: { default: { document: { run: { font: "Times New Roman", size: 22 } } } },
            sections: [{
                properties: { page: { margin: { left: 1701, right: 567, top: 1134, bottom: 1134 } } },
                children: paragraphs
            }]
        });

        const buffer = await Packer.toBuffer(doc);
        const safeTopic = (order.topic || 'Hujjat').replace(/[^a-z0-9\s-]/gi, '_').substring(0, 50);
        const filename = `${safeTopic}_${Date.now()}.docx`;

        await updateProgress(userId, msgId, 100, "Tayyor! Fayl yuborilmoqda...");
        await bot.telegram.sendDocument(userId, { source: buffer, filename }, { caption: "🎉 Tayyor! Marhamat." });
        
        if (msgId) bot.telegram.deleteMessage(userId, msgId).catch(()=>{});

        if (ADMIN_ID) {
            bot.telegram.sendMessage(ADMIN_ID, `🤖 <b>Avtomatlashtirilgan AI Natijasi</b>\n\n👤 Foydalanuvchi: ${userId}\n📌 Mavzu: ${order.topic}`, { parse_mode: 'HTML' });
            bot.telegram.sendDocument(ADMIN_ID, { source: buffer, filename }).catch(()=>{});
        }
        ordersCache.delete(userId);
    } catch (err) {
        console.error("AI Error Chain:", err);
        if (msgId) bot.telegram.deleteMessage(userId, msgId).catch(()=>{});
        
        const friendlyError = err.message.includes("|") 
            ? `⚠️ <b>Tizim xatoligi (API ma'lumotlari):</b>\n\n${err.message.split(" | ").join("\n")}\n\nIltimos, yuqoridagi xatoliklarni bartaraf eting yoki keyinroq urinib ko'ring.`
            : "⚠️ Kechirasiz, tarmoq yoki AI tizimlarida uzilish yuz berdi. Iltimos, qayta urinib ko'ring.";

        bot.telegram.sendMessage(userId, friendlyError, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback("🔄 Qaytadan yozish", "retry_gen_" + userId)]])
        }).catch(()=>{});
    }
}

// -------------------------------------------------------------
// INLINE BUTTON ACTIONS
// -------------------------------------------------------------
bot.action(/^pay_ok_(\d+)$/, async (ctx) => {
    const userId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery('✅ Tasdiqlandi!');
    
    // Notify the user immediately
    bot.telegram.sendMessage(userId, "✅ <b>To'lovingiz tasdiqlandi!</b>\nBot hozir mustaqil ishingizni yozishni boshlaydi. Iltimos kuting...", { parse_mode: 'HTML' }).catch(()=>{});

    ctx.editMessageCaption(ctx.callbackQuery.message.caption + '\n\n✅ <b>TASDIQLANDI</b>', { parse_mode: 'HTML' }).catch(() => {});
    
    const order = ordersCache.get(userId);
    if (order) processAIGeneration(userId, order);
});

bot.action(/^pay_no_(\d+)$/, async (ctx) => {
    const userId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery('❌ Rad etildi');
    ctx.editMessageCaption(ctx.callbackQuery.message.caption + '\n\n❌ RAD ETILDI').catch(() => {});
});

bot.action(/^retry_gen_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('🔄 Qaytadan urunish boshlandi!');
    const userId = parseInt(ctx.match[1]);
    const order = ordersCache.get(userId);
    if (!order) return ctx.reply("Sessiya xotirasi eskirgan. Iltimos boshidan buyurtma bering.");
    
    processAIGeneration(userId, order);
});

// Bekor qilish komandasi (ixtiyoriy)
bot.command('cancel', (ctx) => {
    ctx.reply("Buyurtma bekor qilindi.", getMainMenu());
    ctx.scene.leave();
});

bot.launch().then(() => {
    console.log("Bot muvaffaqiyatli ishga tushdi!");
}).catch((err) => {
    console.error("Bot ishga tushishida xatolik:", err);
});

// Railway.app uchun yengil HTTP server (Port tinglash uchun shart)
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Telegram Bot is running on Railway!\\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Dummy server portda ishga tushdi: ${PORT}`);
});

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
