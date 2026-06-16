/**
 * Telegram Rich Markdown & Channel Formatter Bot — Cloudflare Worker
 *
 * Features:
 * - Direct Messages: Renders any Markdown/HTML sent to the bot.
 * - Channels: Automatically formats posts containing Markdown/HTML tags on publish.
 * - Smart Edit Detection: Ignores posts without formatting to avoid unnecessary (edited) marks.
 * - Per-channel disconnect & channel-only tag guide.
 * - Admin Panel: /stats and /broadcast (Restricted to ADMIN_ID).
 * - Persistent KV Cache for users, channels, and stats tracking.
 */

const BOT_TOKEN = "BOT TOKEN ADD KON INJA";
const ADMIN_ID = 12345677899; #adminuserid
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TTL_PROCESSED_SEC = 30 * 24 * 60 * 60; // 30 days
const TTL_CHANNEL_SEC = 30 * 24 * 60 * 60; // 30 days

export default {
	async fetch(request, env) {
		if (request.method === "GET") return new Response("✅ Bot is running!", { status: 200 });
		if (request.method !== "POST") return new Response("OK");
		if (!env.DB) {
			console.error("KV Namespace 'DB' is not bound!");
			return new Response("KV Setup Error", { status: 500 });
		}
		let update;
		try {
			update = await request.json();
		} catch {
			return new Response("Bad JSON", { status: 400 });
		}
		try {
			if (update.message) {
				await handleMessage(update.message, env);
			} else if (update.callback_query) {
				await handleCallback(update.callback_query, env);
			} else if (update.channel_post) {
				await handleChannelPost(update.channel_post, env);
			}
		} catch (err) {
			console.error("Handler error:", err && err.stack ? err.stack : err);
		}
		return new Response("OK", { status: 200 });
	},
};

// ─── KV Storage Helpers & Stats ───────────────────────────────────────────────
async function registerUser(env, userId) {
	const key = `user:${userId}`;
	const exists = await env.DB.get(key);
	if (!exists) {
		await env.DB.put(key, "1");
		await incrementStat(env, "stats:users");
	}
}
async function kvAuthorizeChannel(env, channelId) {
	await env.DB.put(`channel:${channelId}`, "authorized", { expirationTtl: TTL_CHANNEL_SEC });
}
async function kvDeauthorizeChannel(env, channelId) {
	await env.DB.delete(`channel:${channelId}`);
}
async function kvIsChannelAuthorized(env, channelId) {
	return (await env.DB.get(`channel:${channelId}`)) !== null;
}
async function kvHasProcessedMessage(env, channelId, messageId) {
	return (await env.DB.get(`processed:${channelId}:${messageId}`)) !== null;
}
async function kvMarkMessageProcessed(env, channelId, messageId) {
	await env.DB.put(`processed:${channelId}:${messageId}`, "1", { expirationTtl: TTL_PROCESSED_SEC });
}
async function incrementStat(env, key) {
	let count = parseInt(await env.DB.get(key)) || 0;
	await env.DB.put(key, (count + 1).toString());
}
async function getCachedBot(env) {
	let botStr = await env.DB.get("cache:bot");
	if (botStr) return JSON.parse(botStr);
	const me = await callApi("getMe", {});
	const bot = { id: me?.result?.id, username: me?.result?.username };
	if (!bot.id) throw new Error("getMe failed");
	await env.DB.put("cache:bot", JSON.stringify(bot), { expirationTtl: 86400 });
	return bot;
}
async function kvLinkUserToChannel(env, userId, channelId, title) {
	const key = `user_channels:${userId}`;
	let channels = await env.DB.get(key, "json");
	if (!channels || !Array.isArray(channels)) channels = [];
	if (!channels.find(c => String(c.id) === String(channelId))) {
		channels.push({ id: channelId, title: title });
		await env.DB.put(key, JSON.stringify(channels));
	}
}
async function kvUnlinkUserFromChannel(env, userId, channelId) {
	const key = `user_channels:${userId}`;
	let channels = await env.DB.get(key, "json");
	if (!channels || !Array.isArray(channels)) return;
	channels = channels.filter(c => String(c.id) !== String(channelId));
	await env.DB.put(key, JSON.stringify(channels));
}
async function kvGetUserChannels(env, userId) {
	const key = `user_channels:${userId}`;
	const channels = await env.DB.get(key, "json");
	return channels || [];
}

// ─── Keyboards ────────────────────────────────────────────────────────────────
function mainKeyboard(lang, botUsername) {
	const isFa = lang === "fa";
	return {
		inline_keyboard: [
			[
				{ text: isFa ? "📖 راهنمای Markdown" : "📖 Markdown Guide", callback_data: `${lang}_help_md` },
				{ text: isFa ? "🌐 راهنمای HTML" : "🌐 HTML Guide", callback_data: `${lang}_help_html` },
			],
			[
				{ text: isFa ? "🖼 راهنمای مدیا" : "🖼 Media Guide", callback_data: `${lang}_help_media` },
				{ text: isFa ? "📢 راهنمای کانال" : "📢 Channel Guide", callback_data: `${lang}_help_channel` },
			],
			[
				{ text: isFa ? "🎨 دمو کامل" : "🎨 Full Demo", callback_data: `${lang}_demo` },
				{ text: isFa ? "ℹ️ درباره بات" : "ℹ️ About", callback_data: `${lang}_about` },
			],
			[
				{
					text: isFa ? "➕ افزودن به کانال" : "➕ Add to Channel",
					url: `https://t.me/${botUsername}?startchannel&admin=post_messages+edit_messages`,
				},
			],
			[
				{ text: isFa ? "🇬🇧 Switch to English" : "🇮🇷 تغییر به فارسی", callback_data: isFa ? "en_start" : "fa_start" },
			],
		],
	};
}
function backKeyboard(lang) {
	const isFa = lang === "fa";
	return {
		inline_keyboard: [
			[
				{ text: isFa ? "⬅️ بازگشت به منو" : "⬅️ Back to Menu", callback_data: `${lang}_back` },
				{ text: isFa ? "🇬🇧 English" : "🇮🇷 فارسی", callback_data: isFa ? "en_start" : "fa_start" },
			],
		],
	};
}
// Dynamic keyboard for the channel guide: tag-guide button + a disconnect button per channel.
function channelGuideKeyboard(lang, userChannels) {
	const isFa = lang === "fa";
	const rows = [];
	rows.push([
		{ text: isFa ? "🏷 تگ‌های مخصوص کانال" : "🏷 Channel-only Tags", callback_data: `${lang}_chtags` },
	]);
	for (const c of userChannels || []) {
		rows.push([
			{
				text: (isFa ? "🔌 قطع اتصال: " : "🔌 Disconnect: ") + (c.title || c.id),
				callback_data: `${lang}_off_${c.id}`,
			},
		]);
	}
	rows.push([
		{ text: isFa ? "⬅️ بازگشت به منو" : "⬅️ Back to Menu", callback_data: `${lang}_back` },
		{ text: isFa ? "🇬🇧 English" : "🇮🇷 فارسی", callback_data: isFa ? "en_start" : "fa_start" },
	]);
	return { inline_keyboard: rows };
}
function backToChannelKeyboard(lang) {
	const isFa = lang === "fa";
	return {
		inline_keyboard: [[
			{ text: isFa ? "⬅️ بازگشت به راهنمای کانال" : "⬅️ Back to Channel Guide", callback_data: `${lang}_help_channel` },
		]],
	};
}
const LANG_SELECT_MESSAGE = "🌐 Please choose your language / زبان خود را انتخاب کنید:";
const LANG_SELECT_KEYBOARD = {
	inline_keyboard: [[
		{ text: "🇮🇷 فارسی", callback_data: "fa_start" },
		{ text: "🇬🇧 English", callback_data: "en_start" },
	]],
};

// ─── Handlers ─────────────────────────────────────────────────────────────────
async function handleMessage(message, env) {
	const chatId = message.chat.id;
	const userId = message.from?.id;
	if (!userId) return;
	const rawText = message.text || "";
	const trimmed = rawText.trim();
	await registerUser(env, userId);

	// --- ADMIN COMMANDS ---
	if (userId === ADMIN_ID) {
		if (trimmed === "/stats") {
			const users = (await env.DB.get("stats:users")) || "0";
			const processed = (await env.DB.get("stats:processed")) || "0";
			await sendPlain(chatId, `📊 **Bot Statistics:**\n\n👥 Total Users: ${users}\n🔄 Rendered Posts: ${processed}`);
			return;
		}
		if (trimmed.startsWith("/broadcast ")) {
			const bText = trimmed.replace("/broadcast ", "");
			await sendPlain(chatId, "⏳ Broadcasting message...");
			let cursor = null;
			let count = 0;
			do {
				const list = await env.DB.list({ prefix: "user:", cursor });
				for (const key of list.keys) {
					const uid = key.name.split(":")[1];
					await callApi("sendMessage", { chat_id: uid, text: bText });
					count++;
				}
				cursor = list.list_complete ? null : list.cursor;
			} while (cursor);
			await sendPlain(chatId, `✅ Broadcast sent to ${count} users.`);
			return;
		}
	}

	// --- CHANNEL AUTHORIZATION VIA FORWARD ---
	const fwdChat = message.forward_from_chat || message.forward_origin?.chat;
	if (fwdChat && fwdChat.type === "channel") {
		const channelId = fwdChat.id;
		const botInfo = await getCachedBot(env);
		const member = await callApi("getChatMember", { chat_id: channelId, user_id: botInfo.id });
		const status = member?.result?.status;
		const canEdit = member?.result?.can_edit_messages;

		if ((status === "administrator" || status === "creator") && canEdit) {
			await kvAuthorizeChannel(env, channelId);
			await kvLinkUserToChannel(env, userId, channelId, fwdChat.title || channelId.toString());

			const guideText = `✅ **کانال با موفقیت ثبت شد:** ${fwdChat.title || channelId}\n\nربات از این پس پست‌های دارای مارک‌داون یا HTML را هنگام انتشار، به‌صورت خودکار در این کانال رندر می‌کند.\n\n---\n\n` + HELP_CHANNEL["fa"];
			const userChannels = await kvGetUserChannels(env, userId);
			await sendRichMarkdown(chatId, guideText, channelGuideKeyboard("fa", userChannels));
		} else {
			await sendPlain(chatId, `❌ **احراز هویت شکست خورد.**\nربات باید در کانال ادمین باشد و دسترسی ویرایش پیام (Edit Messages) داشته باشد.`);
		}
		return;
	}

	// --- NORMAL COMMANDS & MESSAGES ---
	if (trimmed === "/start" || trimmed === "/help") {
		await sendPlain(chatId, LANG_SELECT_MESSAGE, LANG_SELECT_KEYBOARD);
		return;
	}

	let text = entitiesToMarkdown(rawText, message.entities).trim();
	if (!text) text = trimmed;
	if (!text) return;

	// Convert custom ///.../// to standard markdown code blocks
	text = text.replace(/\/\/\/([\s\S]+?)\/\/\//g, "```\n$1\n```");

	if (text.startsWith("<") || /<\/?\w/.test(text)) {
		await sendRichHtml(chatId, text);
	} else {
		await sendRichMarkdown(chatId, text);
	}
}

async function handleCallback(cb, env) {
	const chatId = cb.message.chat.id;
	const msgId = cb.message.message_id;
	const data = cb.data;
	await callApi("answerCallbackQuery", { callback_query_id: cb.id });
	const lang = data.startsWith("fa_") ? "fa" : "en";
	const action = data.slice(3);
	const kb = backKeyboard(lang);
	const botInfo = await getCachedBot(env);
	const main = mainKeyboard(lang, botInfo.username);

	if (action === "start" || action === "back") {
		await editRichMarkdown(chatId, msgId, WELCOME[lang], main);
	} else if (action === "help_md") {
		await editRichMarkdown(chatId, msgId, HELP_MD[lang], kb);
	} else if (action === "help_html") {
		await editRichMarkdown(chatId, msgId, HELP_HTML[lang], kb);
	} else if (action === "help_media") {
		await editRichMarkdown(chatId, msgId, HELP_MEDIA[lang], kb);
	} else if (action === "help_channel") {
		const userChannels = await kvGetUserChannels(env, cb.from.id);
		let prefix = "";
		if (userChannels.length > 0) {
			const list = userChannels.map(c => `• ${c.title}`).join("\n");
			prefix = lang === "fa"
				? `✅ **کانال‌های ثبت‌شده‌ی شما:**\n${list}\n\nبرای افزودن کانال جدید، من را در کانال ادمین کنید و یک پیام از آنجا به اینجا فوروارد کنید.\n\n---\n`
				: `✅ **Your Authorized Channels:**\n${list}\n\nTo add a new channel, make me an admin there and forward a message here.\n\n---\n`;
		} else {
			prefix = lang === "fa"
				? `❌ **شما هنوز هیچ کانالی ثبت نکرده‌اید.**\n\nبرای افزودن کانال، من را در کانال ادمین کنید و یک پیام از آنجا به اینجا فوروارد کنید.\n\n---\n`
				: `❌ **You haven't authorized any channels yet.**\n\nTo add a channel, make me an admin there and forward a message here.\n\n---\n`;
		}
		await editRichMarkdown(chatId, msgId, prefix + HELP_CHANNEL[lang], channelGuideKeyboard(lang, userChannels));
	} else if (action === "chtags") {
		// Guide: which tags/styles work in the bot but NOT in the channel.
		await editRichMarkdown(chatId, msgId, HELP_CHANNEL_TAGS[lang], backToChannelKeyboard(lang));
	} else if (action.startsWith("off_")) {
		// Disconnect a channel.
		const channelId = action.slice(4);
		await kvDeauthorizeChannel(env, channelId);
		await kvUnlinkUserFromChannel(env, cb.from.id, channelId);
		const userChannels = await kvGetUserChannels(env, cb.from.id);
		const confirm = lang === "fa"
			? `🔌 **اتصال قطع شد.** ربات دیگر پست‌های آن کانال را قالب‌بندی نمی‌کند.\nهر زمان خواستی دوباره وصل کنی، کافیست یک پیام از کانال را به اینجا فوروارد کنی.\n\n---\n`
			: `🔌 **Disconnected.** The bot will no longer format posts in that channel.\nTo reconnect anytime, just forward a message from the channel here.\n\n---\n`;
		await editRichMarkdown(chatId, msgId, confirm + HELP_CHANNEL[lang], channelGuideKeyboard(lang, userChannels));
	} else if (action === "demo") {
		await editRichMarkdown(chatId, msgId, DEMO[lang], kb);
	} else if (action === "about") {
		await editRichMarkdown(chatId, msgId, ABOUT[lang], kb);
	}
}

// ─── Channel Post Formatter ───────────────────────────────────────────────────
async function handleChannelPost(post, env) {
	const channelId = post.chat?.id;
	const messageId = post.message_id;
	if (!channelId || !messageId) return;
	if (!(await kvIsChannelAuthorized(env, channelId))) return;
	if (await kvHasProcessedMessage(env, channelId, messageId)) return;

	const isCaption = post.caption !== undefined;
	const rawText = isCaption ? post.caption : post.text;
	const entities = isCaption ? post.caption_entities : post.entities;
	if (!rawText || !rawText.trim()) return;

	// Check the RAW text for markdown tags to prevent the bot from editing normal posts
	// or posts where formatting was natively applied by the user (like standard URLs).
	if (!hasRealFormatting(rawText)) return;

	let text = entitiesToMarkdown(rawText, entities).trim();
	if (!text) text = rawText.trim();

	// Convert custom ///.../// to standard markdown code blocks
	text = text.replace(/\/\/\/([\s\S]+?)\/\/\//g, "```\n$1\n```");

	await kvMarkMessageProcessed(env, channelId, messageId);

	let res;
	if (isCaption) {
		// Captions have NO rich field — only classic inline formatting via parse_mode.
		res = await callApi("editMessageCaption", {
			chat_id: channelId,
			message_id: messageId,
			caption: mdInlineToHtml(text),
			parse_mode: "HTML",
		});
	} else {
		// FIX: text posts now use Telegram's NATIVE Rich renderer (same as DMs),
		// so to-do lists / tables / headings render exactly like inside the bot.
		const isHtml = text.startsWith("<") || /<\/?\w/.test(text);
		res = await callApi("editMessageText", {
			chat_id: channelId,
			message_id: messageId,
			rich_message: isHtml ? { html: text } : { markdown: text },
		});
	}

	if (res?.ok) {
		await kvAuthorizeChannel(env, channelId);
		await incrementStat(env, "stats:processed");
	}
}

// ─── Format Detectors & Helpers ───────────────────────────────────────────────
function hasRealFormatting(t) {
	return (
		/\*\*[^\n]+?\*\*/.test(t) ||                          // **bold**
		/__[^\n]+?__/.test(t) ||                              // __bold__
		/~~[^\n]+?~~/.test(t) ||                              // ~~strike~~
		/\|\|[^\n]+?\|\|/.test(t) ||                          // ||spoiler||
		/`[^`\n]+?`/.test(t) ||                               // `code`
		/```[\s\S]+?```/.test(t) ||                           // code block
		/\/\/\/[\s\S]+?\/\/\//.test(t) ||                     // /// code block ///
		/(^|\n)\s{0,3}#{1,6}\s+\S/.test(t) ||                 // # heading (needs a space)
		/(^|\n)\s*[-*+]\s*\[[ xX]\]\s+\S/.test(t) ||          // - [ ] / - [x] task
		/(^|\n)\s*[-*+]\s+\S/.test(t) ||                      // - bullet
		/(^|\n)\s*\d+\.\s+\S/.test(t) ||                      // 1. ordered
		/(^|\n)\s*>\s+\S/.test(t) ||                          // > quote
		/\[[^\]\n]+\]\([^)\n]+\)/.test(t) ||                  // [link](url)
		/(^|\n)\s*\|.+\|\s*(\n|$)/.test(t) ||                 // | table |
		/\$\$[\s\S]+?\$\$/.test(t) ||                         // $$ block math $$
		/\$[^$\n]+\$/.test(t) ||                              // $ inline math $
		/<\/?\w+[^>]*>/.test(t)                               // any real HTML tag
	);
}

function escapeHtml(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Inline-only converter for media CAPTIONS (block elements aren't supported on captions).
function mdInlineToHtml(md) {
	let s = escapeHtml(String(md));
	s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
	s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");
	s = s.replace(/\|\|(.+?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>");
	s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<i>$2</i>");
	s = s.replace(/`([^`\n]+?)`/g, "<code>$1</code>");
	s = s.replace(/\[([^\]\n]+?)\]\((https?:\/\/[^)\n]+)\)/g, '<a href="$2">$1</a>');
	return s;
}

// ─── Convert Telegram message entities back into Markdown source ──────────────
function entitiesToMarkdown(text, entities) {
	if (!entities || !entities.length) return text;
	const items = entities.map((e, idx) => ({ e, idx, start: e.offset, end: e.offset + e.length }));
	function isTopLevel(item, pool) {
		return !pool.some(other => {
			if (other.idx === item.idx) return false;
			const strictlyLarger = other.start <= item.start && other.end >= item.end &&
				(other.start < item.start || other.end > item.end);
			const sameSpanOuter = other.start === item.start && other.end === item.end && other.idx < item.idx;
			return strictlyLarger || sameSpanOuter;
		});
	}
	function render(start, end, pool) {
		const inRange = pool.filter(it => it.start >= start && it.end <= end);
		const top = inRange.filter(it => isTopLevel(it, inRange)).sort((a, b) => a.start - b.start);
		let out = "";
		let pos = start;
		for (const item of top) {
			out += text.slice(pos, item.start);
			const innerPool = pool.filter(p => p.idx !== item.idx);
			const inner = render(item.start, item.end, innerPool);
			out += wrapEntity(item.e, inner);
			pos = item.end;
		}
		out += text.slice(pos, end);
		return out;
	}
	return render(0, text.length, items);
}
function wrapEntity(e, content) {
	switch (e.type) {
		case "bold": return `**${content}**`;
		case "italic": return `*${content}*`;
		case "underline": return `<u>${content}</u>`;
		case "strikethrough": return `~~${content}~~`;
		case "spoiler": return `||${content}||`;
		case "code": return `\`${content}\``;
		case "pre": return "```" + (e.language || "") + "\n" + content + "\n```";
		case "text_link": return `[${content}](${e.url})`;
		case "text_mention": return e.user ? `[${content}](tg://user?id=${e.user.id})` : content;
		case "blockquote":
		case "expandable_blockquote":
			return content.split("\n").map(l => `>${l}`).join("\n");
		default: return content;
	}
}

// ─── API helpers ──────────────────────────────────────────────────────────────
async function sendPlain(chatId, text, replyMarkup) {
	const body = { chat_id: chatId, text, parse_mode: "Markdown" };
	if (replyMarkup) body.reply_markup = replyMarkup;
	await callApi("sendMessage", body);
}
async function sendRichMarkdown(chatId, markdown, replyMarkup) {
	const body = { chat_id: chatId, rich_message: { markdown } };
	if (replyMarkup) body.reply_markup = replyMarkup;
	const res = await callApi("sendRichMessage", body);
	// FIX: if Rich sending fails for any reason, fall back to a plain message so the user always gets it.
	if (!res?.ok) {
		const fb = { chat_id: chatId, text: markdown };
		if (replyMarkup) fb.reply_markup = replyMarkup;
		await callApi("sendMessage", fb);
	}
	return res;
}
async function sendRichHtml(chatId, html, replyMarkup) {
	const body = { chat_id: chatId, rich_message: { html } };
	if (replyMarkup) body.reply_markup = replyMarkup;
	const res = await callApi("sendRichMessage", body);
	if (!res?.ok) {
		const fb = { chat_id: chatId, text: html };
		if (replyMarkup) fb.reply_markup = replyMarkup;
		await callApi("sendMessage", fb);
	}
	return res;
}
async function editRichMarkdown(chatId, messageId, markdown, replyMarkup) {
	const body = { chat_id: chatId, message_id: messageId, rich_message: { markdown } };
	if (replyMarkup) body.reply_markup = replyMarkup;
	await callApi("editMessageText", body);
}
async function callApi(method, body) {
	const res = await fetch(`${TELEGRAM_API}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	let json = null;
	try { json = await res.json(); } catch { json = null; }
	if (!res.ok) {
		console.error(`[${method}] failed`, res.status, json || await res.text().catch(() => ""));
	}
	return json;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTENT
// ═══════════════════════════════════════════════════════════════════════════════
const WELCOME = {
	fa: [
		"# 🤖 Rich Markdown Bot",
		"",
		"هر متن **Markdown** یا **HTML** بفرستید، به صورت Rich Message رندر میشه.",
		"همچنین می‌توانید بات را به کانال خود اضافه کنید تا پست‌ها به صورت خودکار قالب‌بندی شوند.",
		"",
		"از دکمه‌های زیر برای دیدن راهنما و دمو استفاده کنید 👇",
	].join("\n"),
	en: [
		"# 🤖 Rich Markdown Bot",
		"",
		"Send any **Markdown** or **HTML** text and it will be echoed back as a rendered Rich Message.",
		"You can also add this bot to your channel to automatically format posts.",
		"",
		"Use the buttons below to explore 👇",
	].join("\n"),
};
const ABOUT = {
	fa: [
		"# ℹ️ درباره بات",
		"",
		"این بات برای رندر کردن پیام‌های Markdown و HTML شما طراحی شده است. از ساختار مدرن Rich Message تلگرام برای نمایش عناصر پیشرفته استفاده می‌کند. می‌توانید آن را به کانال‌های خود اضافه کنید تا پست‌ها را به صورت خودکار، در لحظه انتشار زیباتر کند.",
	].join("\n"),
	en: [
		"# ℹ️ About",
		"",
		"This bot is designed to render your Markdown and HTML messages natively using Telegram's Rich Message format. You can also add it to your channels to automatically format your posts in real-time as you publish them.",
	].join("\n"),
};
const HELP_CHANNEL = {
	fa: [
		"### 🛠 آموزش اتصال کانال:",
		"1. ربات را به کانال خود اضافه کنید.",
		"2. دسترسی **Edit Messages** (ویرایش پیام‌ها) را به آن بدهید.",
		"3. یک پیام از کانال خود به همینجا (داخل بات) **Forward** کنید.",
		"",
		"پس از تایید، هر زمان که در کانال پست بگذارید (دارای تگ‌های مارک‌داون یا HTML)، بات در لحظه آن را به نسخه رندر شده تغییر می‌دهد!",
		"",
		"*(پست‌هایی که هیچ تگی ندارند نادیده گرفته می‌شوند تا برچسب \"Edited\" نخورند)* ✨",
		"",
		"",
		"### 🏷 تگ‌های مخصوص کانال",
		"بعضی استایل‌ها فقط روی پیام متنی کانال رندر می‌شوند و روی کپشن مدیا (عکس/ویدیو) کار نمی‌کنند. این محدودیتِ خودِ تلگرام است، نه باگ بات.",
		"",
		"**✅ روی پیام متنی کانال کار می‌کند:**",
		"- هدینگ‌ها و برجسته‌سازی متن (# عنوان)",
		"- لیست کارها (- [ ] و - [x])",
		"- جدول‌ها",
		"- بلوک کد و فرمول ریاضی داخل تگ‌های (///....///) یا ($$...$$)",
		"- نقل‌قول (> ...)",
		"- همه‌ی استایل‌های inline (بولد، ایتالیک، خط‌خورده، کد، لینک، اسپویلر)",
		"",
		"**⚠️ روی کپشن مدیا کار نمی‌کند:**",
		"فقط استایل‌های inline رندر می‌شوند:",
		"بولد · ایتالیک · خط‌خورده · کد · لینک · ||اسپویلر||",
		"هدینگ، لیست کارها، جدول، بلوک کد و فرمول روی کپشن نمایش داده نمی‌شوند.",
		"",
		"💡 اگر می‌خواهی todo / جدول / هدینگ داشته باشی، پست را به‌صورت متنی (بدون عکس) بفرست.",
	].join("\n"),

	en: [
		"### 🛠 How to setup:",
		"1. Add the bot to your channel as an administrator.",
		"2. Grant it the **Edit Messages** permission.",
		"3. **Forward** any message from your channel to this bot.",
		"",
		"Once authorized, whenever you post text or media captions containing Markdown/HTML tags, the bot will instantly render it!",
		"",
		"*(Posts without any markdown tags are safely ignored to avoid the \"Edited\" label)* ✨",
	].join("\n"),
};
const HELP_CHANNEL_TAGS = {
	fa: [
		"# 🏷 تگ‌های مخصوص کانال",
		"",
		"بعضی استایل‌ها فقط روی **پیام متنی** کانال رندر می‌شوند و روی **کپشن مدیا** (عکس/ویدیو) کار نمی‌کنند. این محدودیتِ خودِ تلگرام است، نه باگ بات.",
		"",
		"---",
		"## ✅ روی پیام متنی کانال کار می‌کند",
		"- هدینگ‌ها و برجسته‌سازی متن (`# عنوان`)",
		"- لیست کارها (`- [ ]` و `- [x]`)",
		"- جدول‌ها",
		"- بلوک کد و فرمول ریاضی داخل تگ‌های (`///...///`) یا (`$$...$$`)",
		"- نقل‌قول (`> ...`)",
		"- همه‌ی استایل‌های inline (بولد، ایتالیک، خط‌خورده، کد، لینک، اسپویلر)",
		"",
		"---",
		"## ⚠️ روی کپشن مدیا کار نمی‌کند",
		"فقط استایل‌های inline رندر می‌شوند:",
		"**بولد** · *ایتالیک* · ~~خط‌خورده~~ · `کد` · [لینک](http://url) · ||اسپویلر||",
		"",
		"هدینگ، لیست کارها، جدول، بلوک کد و فرمول روی کپشن نمایش داده **نمی‌شوند**.",
		"",
		"> 💡 اگر می‌خواهی todo / جدول / هدینگ داشته باشی، پست را به‌صورت **متنی** (بدون عکس) بفرست.",
	].join("\n"),
	en: [
		"# 🏷 Channel-only Tags",
		"",
		"Some styles only render on a **text post** in a channel and do NOT work on a **media caption** (photo/video). This is a Telegram limitation, not a bot bug.",
		"",
		"---",
		"## ✅ Works on channel text posts",
		"- Headings (`# Title`)",
		"- Task lists (`- [ ]` and `- [x]`)",
		"- Tables",
		"- Code blocks & math inside (`///...///`) or (`$$...$$`)",
		"- Quotes (`> ...`)",
		"- All inline styles (bold, italic, strike, code, links, spoiler)",
		"",
		"---",
		"## ⚠️ Does NOT work on media captions",
		"Only inline styles render:",
		"**bold** · *italic* · ~~strike~~ · `code` · [link](http://url) · ||spoiler||",
		"",
		"Headings, task lists, tables, code blocks and math are **not** shown on captions.",
		"",
		"> 💡 If you need todos / tables / headings, send the post as **text** (no photo).",
	].join("\n"),
};
const HELP_MD = {
	fa: [
		"# 📖 راهنمای Markdown",
		"",
		"متن Markdown بفرستید، رندر شده برمیگرده. کادر خاکستری = چیزی که تایپ میکنید ↓ نتیجه بعدشه.",
		"",
		"---",
		"## Text Styles",
		"```",
		"**bold** *italic* ~~strike~~",
		"`code`  ==marked==  ||spoiler||",
		"```",
		"**bold** *italic* ~~strike~~ `code` ==marked== ||spoiler||",
		"",
		"---",
		"## Headings",
		"```",
		"# Heading 1",
		"## Heading 2",
		"### Heading 3",
		"```",
		"# Heading 1",
		"## Heading 2",
		"### Heading 3",
		"",
		"---",
		"## Lists",
		"```",
		"- milk",
		"- eggs",
		"- [ ] todo",
		"- [x] done",
		"",
		"1. wake up",
		"2. ship it",
		"```",
		"- milk",
		"- eggs",
		"- [ ] todo",
		"- [x] done",
		"",
		"1. wake up",
		"2. ship it",
		"",
		"---",
		"## Code Blocks",
		"```",
		" \\`\\`\\`python",
		" print(\"hello\")",
		" \\`\\`\\`",
		"```",
		"```python",
		"print(\"hello\")",
		"```",
	].join("\n"),
	en: [
		"# 📖 Markdown Guide",
		"",
		"Send Markdown text and get it echoed back rendered. Grey box = what you type ↓ result comes right after.",
		"",
		"---",
		"## Text Styles",
		"```",
		"**bold** *italic* ~~strike~~",
		"`code`  ==marked==  ||spoiler||",
		"```",
		"**bold** *italic* ~~strike~~ `code` ==marked== ||spoiler||",
		"",
		"---",
		"## Headings",
		"```",
		"# Heading 1",
		"## Heading 2",
		"### Heading 3",
		"```",
		"# Heading 1",
		"## Heading 2",
		"### Heading 3",
		"",
		"---",
		"## Lists",
		"```",
		"- milk",
		"- eggs",
		"- [ ] todo",
		"- [x] done",
		"```",
		"- milk",
		"- eggs",
		"- [ ] todo",
		"- [x] done",
		"",
		"---",
		"## Code Blocks",
		"```",
		" \\`\\`\\`python",
		" print(\"hello\")",
		" \\`\\`\\`",
		"```",
		"```python",
		"print(\"hello\")",
		"```",
	].join("\n"),
};
const HELP_HTML = {
	fa: [
		"# 🌐 راهنمای HTML",
		"",
		"اگه پیامت با `<` شروع بشه، بات به عنوان HTML رندر میکنه.",
		"",
		"---",
		"## Text Styles",
		"```",
		"<b>bold</b> <i>italic</i> <u>underline</u>",
		"<s>strike</s> <code>code</code> <mark>marked</mark>",
		"<tg-spoiler>spoiler</tg-spoiler>",
		"```",
		"<b>bold</b> <i>italic</i> <u>underline</u> <s>strike</s> <code>code</code> <mark>marked</mark> <tg-spoiler>spoiler</tg-spoiler>",
		"",
		"---",
		"## Lists",
		"```",
		"<ul><li>milk</li><li>eggs</li></ul>",
		"<ol><li>wake up</li></ol>",
		"```",
		"<ul><li>milk</li><li>eggs</li></ul><ol><li>wake up</li></ol>",
	].join("\n"),
	en: [
		"# 🌐 HTML Guide",
		"",
		"If your message starts with `<`, the bot renders it as HTML.",
		"",
		"---",
		"## Text Styles",
		"```",
		"<b>bold</b> <i>italic</i> <u>underline</u>",
		"<s>strike</s> <code>code</code> <mark>marked</mark>",
		"<tg-spoiler>spoiler</tg-spoiler>",
		"```",
		"<b>bold</b> <i>italic</i> <u>underline</u> <s>strike</s> <code>code</code> <mark>marked</mark> <tg-spoiler>spoiler</tg-spoiler>",
		"",
		"---",
		"## Lists",
		"```",
		"<ul><li>milk</li><li>eggs</li></ul>",
		"<ol><li>wake up</li></ol>",
		"```",
		"<ul><li>milk</li><li>eggs</li></ul><ol><li>wake up</li></ol>",
	].join("\n"),
};
const HELP_MEDIA = {
	fa: [
		"# 🖼 راهنمای مدیا",
		"",
		"برای ارسال مدیا در Rich Message از سینتکس تصویر Markdown استفاده کنید.",
		"",
		"---",
		"## عکس / ویدیو",
		"```",
		"![]([https://telegram.org/example/photo.jpg](https://telegram.org/example/photo.jpg))",
		"![]([https://telegram.org/example/video.mp4](https://telegram.org/example/video.mp4))",
		"```",
		"",
		"---",
		"## اسلایدشو",
		"```",
		"<tg-slideshow>",
		"  <img src=\"[https://telegram.org/example/photo.jpg](https://telegram.org/example/photo.jpg)\"/>",
		"  <video src=\"[https://telegram.org/example/video.mp4](https://telegram.org/example/video.mp4)\"/>",
		"</tg-slideshow>",
		"```",
	].join("\n"),
	en: [
		"# 🖼 Media Guide",
		"",
		"Use Markdown image syntax to embed media in Rich Messages.",
		"",
		"---",
		"## Photo / Video",
		"```",
		"![]([https://telegram.org/example/photo.jpg](https://telegram.org/example/photo.jpg))",
		"![]([https://telegram.org/example/video.mp4](https://telegram.org/example/video.mp4))",
		"```",
		"",
		"---",
		"## Slideshow",
		"```",
		"<tg-slideshow>",
		"  <img src=\"[https://telegram.org/example/photo.jpg](https://telegram.org/example/photo.jpg)\"/>",
		"  <video src=\"[https://telegram.org/example/video.mp4](https://telegram.org/example/video.mp4)\"/>",
		"</tg-slideshow>",
		"```",
	].join("\n"),
};
const DEMO = {
	fa: [
		"# 🎨 دمو کامل",
		"",
		"**Bold** _italic_ ~~strike~~ `code` ==highlight== ||spoiler|| <u>underline</u>",
		"",
		">نقل‌قول با **bold**",
		"",
		"- [ ] Task 1",
		"- [x] Task 2",
		"",
		"```python",
		"print(\"Hello Telegram\")",
		"```",
		"",
		"| Lang | Speed |",
		"|:-----|------:|",
		"| Rust | fast  |",
		"",
		"Inline $E = mc^2$",
		"$$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$",
	].join("\n"),
	en: [
		"# 🎨 Full Demo",
		"",
		"**Bold** _italic_ ~~strike~~ `code` ==highlight== ||spoiler|| <u>underline</u>",
		"",
		">Quote with **bold**",
		"",
		"- [ ] Task 1",
		"- [x] Task 2",
		"",
		"```python",
		"print(\"Hello Telegram\")",
		"```",
		"",
		"| Lang | Speed |",
		"|:-----|------:|",
		"| Rust | fast  |",
		"",
		"Inline $E = mc^2$",
		"$$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$",
	].join("\n"),
};
