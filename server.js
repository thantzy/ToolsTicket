const { Client, GatewayIntentBits, ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const transcript = require('discord-html-transcripts');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const cors = require('cors');
app.use(cors());
app.use(express.json());

const DB_FILE = '/tmp/database.json';

// --- DATABASE LOGIC ---
function readDB() {
    try {
        if (!fs.existsSync(DB_FILE)) return { guilds: {}, staffStats: {}, history: {} };
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) { 
        return { guilds: {}, staffStats: {}, history: {} }; 
    }
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function logActivity() {
    const db = readDB();
    const today = new Date().toLocaleDateString('en-GB').split('/').reverse().join('-');
    db.history[today] = (db.history[today] || 0) + 1;
    saveDB(db);
}

// --- BOT CONFIGURATION ---
const TOKEN = process.env.TOKEN;
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers // TAMBAHKAN INI
    ] 
});

const langMap = {
    id: {
        embedTitle: "Detail Transaksi", cat: "Kategori", detail: "Detail Pesanan", payDesc: "Silahkan pilih metode pembayaran di bawah:",
        btnIndo: "Indonesia (QRIS)", btnGlobal: "Global (PayPal/Crypto)", btnClose: "Tutup Ticket",
        qrisMsg: "Silahkan scan QRIS dan kirim bukti transfer.", globalMsg: "Hubungi staff untuk instruksi PayPal/Crypto.",
        closeReason: "Alasan Penutupan", staffPoint: "Total Point Staff", deleting: "Channel akan dihapus dalam 5 detik..."
    },
    en: {
        embedTitle: "Transaction Detail", cat: "Category", detail: "Order Detail", payDesc: "Please select a payment method below:",
        btnIndo: "Indonesia (QRIS)", btnGlobal: "Global (PayPal/Crypto)", btnClose: "Close Ticket",
        qrisMsg: "Please scan the QRIS and send proof of transfer.", globalMsg: "Contact staff for PayPal/Crypto instructions.",
        closeReason: "Closing Reason", staffPoint: "Staff Total Points", deleting: "Channel will be deleted in 5 seconds..."
    }
};

client.on('ready', () => console.log(`🚀 Bot Online: ${client.user.tag}`));

// --- DISCORD INTERACTIONS ---
client.on('interactionCreate', async interaction => {
    const db = readDB();
    const config = db.guilds[interaction.guildId];

    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_select') {
        const selectedValue = interaction.values[0];
        const categoryData = config?.options?.find(opt => opt.value === selectedValue);
        
        const modal = new ModalBuilder().setCustomId(`modal_ticket_${selectedValue}`).setTitle(`Formulir ${categoryData?.label || 'Ticket'}`);
        const inputDetail = new TextInputBuilder().setCustomId('input_detail').setLabel((categoryData?.question || "Detail Pesanan").substring(0, 45)).setStyle(TextInputStyle.Paragraph).setRequired(true);
        const inputLang = new TextInputBuilder().setCustomId('input_lang').setLabel("Language: id / en").setPlaceholder("id / en").setMinLength(2).setMaxLength(2).setStyle(TextInputStyle.Short).setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(inputDetail), new ActionRowBuilder().addComponents(inputLang));
        await interaction.showModal(modal);
    }

    if (interaction.isButton()) {
        const topic = interaction.channel.topic || "";
        const lang = (topic.match(/Lang: ([a-z]{2})/) || [])[1] || 'id';
        const text = langMap[lang];

        if (interaction.customId === 'pay_indo') {
            await interaction.reply({ content: text.qrisMsg, ephemeral: true });
            if (fs.existsSync('./qris.png')) await interaction.channel.send({ files: ["./qris.png"] });
        }
        if (interaction.customId === 'pay_global') await interaction.reply({ content: text.globalMsg, ephemeral: true });
        if (interaction.customId === 'claim_ticket') {
            const STAFF_ROLE_ID = '1427286590824382524';
            
            // Cek apakah user punya role staff
            if (!interaction.member.roles.cache.has(STAFF_ROLE_ID)) {
                return interaction.reply({ content: "❌ Hanya staff yang bisa meng-claim ticket ini!", ephemeral: true });
            }

            // Cek apakah sudah di-claim sebelumnya (menggunakan topic atau pesan)
            if (interaction.channel.topic.includes("Claimed By:")) {
                return interaction.reply({ content: "❌ Ticket ini sudah di-claim oleh staff lain.", ephemeral: true });
            }

            // Update Topic Channel untuk mencatat siapa yang claim
            const currentTopic = interaction.channel.topic || "";
            await interaction.channel.setTopic(`${currentTopic} | Claimed By: ${interaction.user.id}`);

            // Beri tahu di channel
            const claimEmbed = new EmbedBuilder()
                .setDescription(`✅ Ticket telah di-claim oleh ${interaction.user}`)
                .setColor("#22c55e");

            // Nonaktifkan tombol claim agar tidak bisa diklik lagi
            await interaction.update({ components: [
                new ActionRowBuilder().addComponents(
                    interaction.message.components[0].components.map(btn => {
                        const newBtn = ButtonBuilder.from(btn);
                        if (btn.customId === 'claim_ticket') newBtn.setDisabled(true).setLabel(`Claimed by ${interaction.user.username}`);
                        return newBtn;
                    })
                )
            ]});

            await interaction.channel.send({ embeds: [claimEmbed] });
        }
        if (interaction.customId === 'close_ticket') {
            if (!interaction.member.permissions.has('ManageMessages')) return interaction.reply({ content: "❌ No Permission", ephemeral: true });
            const modal = new ModalBuilder().setCustomId('modal_confirm_close').setTitle(text.closeReason);
            const reasonInput = new TextInputBuilder().setCustomId('close_reason').setLabel(text.closeReason).setStyle(TextInputStyle.Short).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
            await interaction.showModal(modal);
        }
    }

    if (interaction.isModalSubmit()) {
if (interaction.customId.startsWith('modal_ticket_')) {
    await interaction.deferReply({ ephemeral: true });
    
    // 1. Ambil data dasar
    const categoryValue = interaction.customId.replace('modal_ticket_', ''); 
    const detail = interaction.fields.getTextInputValue('input_detail');
    const lang = interaction.fields.getTextInputValue('input_lang').toLowerCase() === 'en' ? 'en' : 'id';
    const text = langMap[lang];

    // 2. CARI DATA MODUL BERDASARKAN VALUE
    // Kita mencari di config.options (data yang Anda save dari dashboard)
    const moduleData = config.options.find(opt => opt.value === categoryValue);
    
    // Ambil tipe modul (purchase/giveaway/support), default ke support jika tidak ketemu
    const moduleType = moduleData ? moduleData.type : 'support';

    // 3. Database & Counter
    let currentCount = (config.ticketCount || 0) + 1;
    db.guilds[interaction.guildId].ticketCount = currentCount;
    saveDB(db);
    logActivity();

    const paddedCount = String(currentCount).padStart(3, '0');
    
    // --- PEMBUATAN CHANNEL ---
    const channel = await interaction.guild.channels.create({
        name: `${paddedCount}-${lang}-${categoryValue}`,
        parent: config.categoryId || null,
        topic: `Type: ${moduleType} | Lang: ${lang} | User: ${interaction.user.id}`,
        permissionOverwrites: [
            { id: interaction.guild.id, deny: ['ViewChannel'] },
            { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages', 'AttachFiles', 'ReadMessageHistory', 'EmbedLinks'] },
            { id: client.user.id, allow: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ManageChannels'] }
        ],
    });

    // --- LOGIKA DINAMIS TOMBOL ---
    const row = new ActionRowBuilder();
    
    // Tombol WAJIB
    row.addComponents(
        new ButtonBuilder().setCustomId('claim_ticket').setLabel('Claim Ticket').setStyle(ButtonStyle.Secondary).setEmoji('🙋‍♂️'),
        new ButtonBuilder().setCustomId('close_ticket').setLabel(text.btnClose).setStyle(ButtonStyle.Danger)
    );

    // LOGIKA BERDASARKAN TIPE (Hasil input dashboard)
    if (moduleType === 'purchase') {
        // Tambahkan tombol pembayaran jika tipe adalah Purchase
        row.addComponents(
            new ButtonBuilder().setCustomId('pay_indo').setLabel(text.btnIndo).setStyle(ButtonStyle.Success).setEmoji('🇮🇩'),
            new ButtonBuilder().setCustomId('pay_global').setLabel(text.btnGlobal).setStyle(ButtonStyle.Primary).setEmoji('🌐')
        );
    }

    // 4. Penentuan Warna & Deskripsi Berdasarkan Tipe
    let embedColor = '#6366f1'; // Default Indigo
    let footerText = "Silahkan tunggu staff merespon bantuan Anda.";

    if (moduleType === 'purchase') {
        embedColor = '#a050ff'; // Ungu
        footerText = text.payDesc;
    } else if (moduleType === 'giveaway') {
        embedColor = '#f43f5e'; // Pink/Rose
        footerText = "Silahkan kirimkan bukti kemenangan giveaway Anda.";
    }

    const embed = new EmbedBuilder()
        .setTitle(`🎫 ${moduleData?.label || 'TICKET'} #${paddedCount}`)
        .setDescription(
            `**${text.cat}:** ${moduleType.toUpperCase()}\n` +
            `**User:** ${interaction.user}\n` +
            `**${text.detail}:**\n\`\`\`${detail}\`\`\`\n` +
            `\n${footerText}`
        )
        .setColor(embedColor)
        .setTimestamp();

    await channel.send({ 
        content: `${interaction.user} | <@&1427286590824382524>`, 
        embeds: [embed], 
        components: [row] 
    });

    await interaction.editReply(`✅ Ticket Created: ${channel}`);
}

if (interaction.customId === 'modal_confirm_close') {
    try {
        const reason = interaction.fields.getTextInputValue('close_reason');
        const topic = interaction.channel.topic || "";
        const lang = (topic.match(/Lang: ([a-z]{2})/) || [])[1] || 'id';
        const text = langMap[lang];

        // 1. Ambil ID Staff yang melakukan CLAIM dari topic channel
        const claimedMatch = topic.match(/Claimed By: (\d+)/);
        const claimerId = claimedMatch ? claimedMatch[1] : null;

        await interaction.reply({ 
            content: `⏳ Menyiapkan transkrip dan menutup channel...`, 
            ephemeral: true 
        });

        // 2. LOGIKA POIN: Hanya berikan poin jika ada Claimer
        if (claimerId) {
            // Update poin untuk staff yang CLAIM, bukan yang menutup (kecuali orangnya sama)
            if (!db.staffStats[claimerId]) {
                // Coba ambil username staff tersebut jika belum ada di DB
                const staffUser = await client.users.fetch(claimerId).catch(() => null);
                db.staffStats[claimerId] = { points: 0, name: staffUser ? staffUser.username : "Unknown Staff" };
            }
            db.staffStats[claimerId].points += 1;
            saveDB(db);
        }

        // 3. Buat Transkrip
        const file = await transcript.createTranscript(interaction.channel, { 
            limit: -1, 
            saveImages: true,
            filename: `transcript-${interaction.channel.name}.html` 
        });

        const type = (topic.match(/Type: ([^ |]+)/) || [])[1];
        const logChannelId = config?.options?.find(opt => opt.value === type)?.transcriptId;

        // 4. Kirim ke Log Channel
        if (logChannelId) {
            const logChan = await client.channels.fetch(logChannelId).catch(() => null);
            if (logChan) {
                const logEmbed = new EmbedBuilder()
                    .setTitle("📝 Ticket Transcript")
                    .addFields(
                        { name: "Category", value: `\`${type}\``, inline: true },
                        { name: "Staff (Claimer)", value: claimerId ? `<@${claimerId}>` : "⚠️ *Tidak diklaim*", inline: true },
                        { name: "Closed By", value: `${interaction.user}`, inline: true },
                        { name: "Total Points Staff", value: `\`${claimerId ? db.staffStats[claimerId].points : 0}\``, inline: true },
                        { name: "Reason", value: `\`\`\`${reason}\`\`\`` }
                    )
                    .setColor(claimerId ? "#22c55e" : "#ff4747") // Hijau jika valid, Merah jika tanpa claim
                    .setTimestamp();
                await logChan.send({ embeds: [logEmbed], files: [file] });
            }
        }

        // 5. Notifikasi Akhir & Hapus Channel
        await interaction.followUp({ content: `✅ ${text.deleting}`, ephemeral: true }).catch(() => null);

        setTimeout(async () => {
            try {
                if (interaction.channel) await interaction.channel.delete();
            } catch (err) {
                console.error("Gagal menghapus channel:", err.message);
            }
        }, 5000);

    } catch (error) {
        console.error("Error saat menutup ticket:", error);
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: "❌ Terjadi kesalahan saat memproses penutupan ticket.", ephemeral: true }).catch(() => null);
        }
    }
}
    }
});

// --- WEB API & DASHBOARD ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API untuk mengambil data ke Dashboard
app.get('/api/stats', async (req, res) => {
    const db = readDB();
    const STAFF_ROLE_ID = '1427286590824382524';
    
    const guildIds = Object.keys(db.guilds);
    if (guildIds.length === 0) return res.json({ staffList: [], totalTickets: 0 });

    const targetGuildId = guildIds[0];
    const config = db.guilds[targetGuildId];

    try {
        const guild = client.guilds.cache.get(targetGuildId);
        
        if (!guild) {
            return res.json({ staffList: [], error: "Bot belum masuk ke server tersebut." });
        }

        // Ambil list staff dari DB, lalu filter menggunakan CACHE (bukan fetch)
        const filteredStaffList = Object.keys(db.staffStats).map(userId => {
            // Kita gunakan cache.get, bukan fetch, untuk menghindari rate limit
            const member = guild.members.cache.get(userId);
            
            return {
                name: db.staffStats[userId].name,
                points: db.staffStats[userId].points,
                // Jika member ada di cache, cek rolenya. Jika tidak ada, anggap bukan staff
                isStaff: member ? member.roles.cache.has(STAFF_ROLE_ID) : false
            };
        })
        .filter(s => s.isStaff) // Hanya yang punya role
        .sort((a, b) => b.points - a.points);

        const totalTickets = Object.values(db.guilds).reduce((a, b) => a + (b.ticketCount || 0), 0);
        const labels = Object.keys(db.history).sort().slice(-7);
        const dataPoints = labels.map(l => db.history[l]);

        res.json({ staffList: filteredStaffList, totalTickets, labels, dataPoints, config, firstGuildId: targetGuildId });
        
    } catch (error) {
        console.error("Gagal memfilter staff:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// API untuk menyimpan konfigurasi
app.post('/api/save', async (req, res) => {
    const { guildId, channelId, categoryId, options } = req.body;
    const db = readDB();

    db.guilds[guildId] = { ...db.guilds[guildId], channelId, categoryId, options };
    saveDB(db);

    try {
        const guild = await client.guilds.fetch(guildId);
        const channel = await guild.channels.fetch(channelId);

        const select = new StringSelectMenuBuilder()
            .setCustomId('ticket_select')
            .setPlaceholder('Select a service...')
            .addOptions(options.map(opt => ({ label: opt.label, value: opt.value })));

        const row = new ActionRowBuilder().addComponents(select);
        const embed = new EmbedBuilder()
            .setTitle('📩 Support Ticket')
            .setDescription('Silahkan pilih kategori di bawah untuk memulai chat dengan staff.')
            .setColor('#6366f1');

        await channel.send({ embeds: [embed], components: [row] });
        res.sendStatus(200);
    } catch (e) {
        console.error(e);
        res.status(500).send(e.message);
    }
});

app.post('/api/save-config', async (req, res) => {
    // 1. Ambil data (Pastikan categoryId masuk ke sini)
    const { guildId, channelId, categoryId, options, panelTitle, panelDesc, panelImage } = req.body;
    
    const db = readDB();
    
    // 2. Inisialisasi object jika belum ada agar tidak error "undefined"
    if (!db.guilds[guildId]) db.guilds[guildId] = {};
    
    // Simpan data utama
    db.guilds[guildId].channelId = channelId;
    db.guilds[guildId].categoryId = categoryId;
    db.guilds[guildId].options = options;
    
    // Simpan data tampilan panel (kita simpan di dalam objek 'panel' supaya rapi)
    db.guilds[guildId].panel = {
        title: panelTitle,
        desc: panelDesc,
        image: panelImage
    };
    
    saveDB(db);

    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) return res.status(404).send("Channel not found");

        // Gunakan data dari website
        const embed = new EmbedBuilder()
            .setTitle(panelTitle || "📩 Support Ticket")
            .setDescription(panelDesc || "Silahkan pilih kategori di bawah untuk memulai.")
            .setColor("#6366f1")
            .setFooter({ text: "V2.0 Core Interface", iconURL: client.user.displayAvatarURL() })
            .setTimestamp();

        if (panelImage && panelImage.startsWith('http')) {
            embed.setImage(panelImage);
        }

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('ticket_select')
            .setPlaceholder('Pilih Jenis Layanan...')
            .addOptions(options.map(opt => ({
                label: opt.label,
                value: opt.value,
                description: `Buka ticket untuk ${opt.label}`
            })));

        const row = new ActionRowBuilder().addComponents(selectMenu);

        await channel.send({ embeds: [embed], components: [row] });
        res.send("Success");
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Dashboard: http://localhost:${PORT}`));

client.login(TOKEN);

