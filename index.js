require('dotenv').config();
const { Telegraf, session, Scenes, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;

// Statistikali in-memory saqlash
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
const orderWizard = new Scenes.WizardScene(
    'order-wizard',
    (ctx) => {
        ctx.reply("Ismingiz nima?", Markup.removeKeyboard());
        ctx.scene.session.order = {};
        return ctx.wizard.next();
    },
    (ctx) => {
        if (!ctx.message || !ctx.message.text) {
            return ctx.reply("Iltimos, ismingizni matn ko'rinishida kiriting:");
        }
        ctx.scene.session.order.name = ctx.message.text;
        ctx.reply("Telefon raqamingizni kiriting:", Markup.keyboard([
            Markup.button.contactRequest("📱 Raqamni yuborish")
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    (ctx) => {
        if (!ctx.message) return ctx.reply("Iltimos, telefon raqamingizni kiriting.");

        let phone = "";
        if (ctx.message.contact) {
            phone = ctx.message.contact.phone_number;
        } else if (ctx.message.text) {
            phone = ctx.message.text;
        } else {
            return ctx.reply("Iltimos, telefon raqamingizni kiriting:");
        }

        ctx.scene.session.order.phone = phone;
        ctx.reply("Qaysi xizmat kerak?", Markup.keyboard([
            ['Telegram bot', 'Veb-sayt', 'SMM']
        ]).oneTime().resize());
        return ctx.wizard.next();
    },
    (ctx) => {
        if (!ctx.message || !ctx.message.text) {
            return ctx.reply("Iltimos, xizmat turini tanlang:");
        }
        ctx.scene.session.order.service = ctx.message.text;
        ctx.reply("Qo'shimcha izohingiz bormi? (Yo'q bo'lsa 'Yoq' deb yozishingiz mumkin)", Markup.removeKeyboard());
        return ctx.wizard.next();
    },
    (ctx) => {
        if (!ctx.message || !ctx.message.text) {
            return ctx.reply("Iltimos, qo'shimcha izoh kiriting (yoki 'Yoq' deb yozing):");
        }
        ctx.scene.session.order.comment = ctx.message.text;

        const order = ctx.scene.session.order;

        ctx.reply("✅ Buyurtmangiz qabul qilindi! Tez orada aloqaga chiqamiz.", getMainMenu());

        totalOrders++;

        // Adminga xabar yuborish
        if (ADMIN_ID) {
            const adminMsg = `🆕 <b>YANGI BUYURTMA!</b>\n\n` +
                `👤 Ism: ${order.name}\n` +
                `📞 Telefon: ${order.phone}\n` +
                `💼 Xizmat: ${order.service}\n` +
                `📝 Izoh: ${order.comment}\n` +
                `Username: @${ctx.from.username || "yo'q"}`;

            bot.telegram.sendMessage(ADMIN_ID, adminMsg, { parse_mode: 'HTML' })
                .catch(err => console.log('Adminga xabar yuborishda xatolik:', err));
        }

        return ctx.scene.leave();
    }
);

const stage = new Scenes.Stage([orderWizard]);
bot.use(session());
bot.use(stage.middleware());

// Asosiy menyu
function getMainMenu() {
    return Markup.keyboard([
        ['Xizmatlarimiz', 'Narxlar'],
        ['Buyurtma berish', 'Bog\'lanish'],
        ['Savollar']
    ]).resize();
}

// ---------------- HANDLERS ----------------

// /start komandasi
bot.start((ctx) => {
    ctx.reply(`Salom! Bizning botimizga xush kelibsiz. Quyidagi menyudan kerakli bo'limni tanlang:`, getMainMenu());
});

// /admin komandasi
bot.command('admin', (ctx) => {
    if (ctx.from.id.toString() === ADMIN_ID) {
        ctx.reply(`📊 <b>Bot Statistikasi:</b>\n\n👥 Botdan foydalanganlar: ${uniqueUsers.size}\n🛍 Jami buyurtmalar: ${totalOrders}`, { parse_mode: 'HTML' });
    } else {
        ctx.reply("Sizda admin huquqi yo'q.");
    }
});

// 1. Xizmatlarimiz
bot.hears('Xizmatlarimiz', (ctx) => {
    ctx.reply("Bizning xizmatlarimiz:", Markup.inlineKeyboard([
        [Markup.button.callback('🤖 Telegram bot yasash', 'service_bot')],
        [Markup.button.callback('🌐 Veb-sayt yasash', 'service_web')],
        [Markup.button.callback('📈 SMM xizmati', 'service_smm')]
    ]));
});

bot.action('service_bot', (ctx) => {
    ctx.answerCbQuery();
    ctx.reply("🤖 <b>Telegram bot yasash</b>\n\nSizning biznesingiz uchun bot yasab beramiz. Ushbu bot orqali siz mijozlarga avtomatik xizmat ko'rsata olasiz.", { parse_mode: 'HTML' });
});

bot.action('service_web', (ctx) => {
    ctx.answerCbQuery();
    ctx.reply("🌐 <b>Veb-sayt yasash</b>\n\nZamonaviy veb-sayt yasab beramiz. Sizning biznesingiz internetda o'z o'rnini topishi uchun yordam beramiz.", { parse_mode: 'HTML' });
});

bot.action('service_smm', (ctx) => {
    ctx.answerCbQuery();
    ctx.reply("📈 <b>SMM xizmati</b>\n\nIjtimoiy tarmoqlarni boshqaramiz. Profilingizni chiroyli olib boramiz va mijozlaringizni ko'paytiramiz.", { parse_mode: 'HTML' });
});

// 2. Narxlar
bot.hears('Narxlar', (ctx) => {
    ctx.reply("💰 <b>Narxlarimiz:</b>\n\n" +
        "🤖 Kurs ishi: <b>100$</b> dan boshlab\n" +
        "🌐 Veb-sayt: <b>300$</b> dan boshlab\n" +
        "📈 SMM: oyiga <b>150$</b>",
        {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🛒 Telegram botga buyurtma', 'order_start')],
                [Markup.button.callback('🛒 Veb-saytga buyurtma', 'order_start')],
                [Markup.button.callback('🛒 SMM uchun buyurtma', 'order_start')]
            ])
        });
});

bot.action('order_start', (ctx) => {
    ctx.answerCbQuery();
    ctx.scene.enter('order-wizard');
});

// 3. Buyurtma berish
bot.hears('Buyurtma berish', (ctx) => {
    ctx.scene.enter('order-wizard');
});

// 4. Bog'lanish
bot.hears('Bog\'lanish', (ctx) => {
    ctx.reply("📞 <b>Biz bilan bog'lanish:</b>\n\n" +
        "✈️ Telegram: @dil_parvozi\n" +
        "📱 Telefon: +998913331303\n" +
        "🕒 Ish vaqti: 09:00 — 18:00", { parse_mode: 'HTML' });
});

// 5. Savollar
bot.hears('Savollar', (ctx) => {
    ctx.reply("❓ <b>Ko'p beriladigan savollar:</b>\n\n" +
        "<b>Qancha vaqtda tayyor bo'ladi?</b>\n— 3 kundan 14 kungacha.\n\n" +
        "<b>To'lov qanday?</b>\n— Yarmi oldindan, yarmi keyin.\n\n" +
        "<b>Kafolat bormi?</b>\n— Ha, 30 kun bepul tuzatamiz.", { parse_mode: 'HTML' });
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
const http = require('http');
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
