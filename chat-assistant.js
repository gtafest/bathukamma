/* ============================================================
   Volunteer Form Chat Assistant
   - Floating chat widget that helps students fill out the form
   - Powered by Groq's free LLM API (llama-3.1-8b-instant)
   - Falls back to a built-in FAQ if no API key is set or API fails
   ============================================================ */

const chatFab = document.getElementById('chatFab');
const chatPanel = document.getElementById('chatPanel');
const chatClose = document.getElementById('chatClose');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatMessages = document.getElementById('chatMessages');

const SYSTEM_PROMPT = `You are a friendly, warm assistant helping students and adults sign up to volunteer at GTA Bathukamma 2026, organized by the Global Telangana Association (GTA), Atlanta chapter.

Event facts:
- Bathukamma is Telangana's festival of flowers.
- Date: Saturday, October 17, 2026. Volunteer hours: 9:00 AM – 10:00 PM EST.
- Venue: Denmark High School (indoors). The GTA team emails each volunteer's assignment before the event.

Your job:
- Help people complete the short sign-up form and explain what each field means
- Explain what kinds of volunteer roles are available (registration & check-in desk, food service, water & refreshments, stage support, cultural program support, Bathukamma receiving & transport, Bathukamma line formation, Nimajjanam/immersion support, parking & traffic). The choice is a preference only: final assignments are made on the day based on where help is needed, so volunteers should be flexible
- Be encouraging — many student volunteers are volunteering for the first time
- Keep answers SHORT (1-3 sentences max), warm, and age-appropriate

Important context:
- The form asks only for: student or adult, name, (students: grade, school, parent/guardian name), email, phone, preferred shift, hours, preferred area, and optional allergy/medical notes.
- This form is run by GTA, NOT by the student's school. School is asked only so GTA knows where volunteers come from.
- Parent/guardian consent is REQUIRED for every student volunteer; the parent's email is verified with a 6-digit code and the parent's phone is the emergency contact.
- "Hours" is an estimate of how many hours the volunteer can help (volunteer hours run 9 AM – 10 PM; any amount is welcome).
- On event day a GTA admin scans the volunteer's QR code (from the confirmation email) at arrival and departure; hours and the certificate are based on those scans.

If someone asks something off-topic (homework, personal advice, inappropriate content), kindly redirect them to the form or to their parent/teacher. Never collect personal info beyond what the form asks for. If asked something specific you do not know (program schedule, parking details), say the GTA team will share full details by email after sign-up.`;

// Conversation history (kept in memory only, never saved)
let conversation = [{ role: 'system', content: SYSTEM_PROMPT }];

// Built-in FAQ — used as fallback when no API key or when API is down
const BUILTIN_FAQ = [
  {
    triggers: ['gta', 'who is gta', 'what is gta', 'global telangana'],
    answer: "GTA is the Global Telangana Association — a community organization. Its Atlanta chapter is hosting GTA Bathukamma 2026, celebrating Telangana's festival of flowers with music, dance, food, and family activities."
  },
  {
    triggers: ['bathukamma', 'festival', 'event', 'when', 'date', 'what is the event'],
    answer: "GTA Bathukamma 2026 is on Saturday, October 17, 2026. Volunteer hours are 9 AM – 10 PM EST. Bathukamma is Telangana's festival of flowers. It is held indoors at Denmark High School. The GTA team will email your assignment before the event."
  },
  {
    triggers: ['parent', 'consent', 'guardian', 'permission'],
    answer: "Yes — parent or guardian consent is required for every student volunteer. Your parent or guardian gives their name, email and phone, and ticks the consent box at the bottom of the form."
  },
  {
    triggers: ['role', 'roles', 'what can i do', 'what will i do', 'job', 'task'],
    answer: "Volunteer areas include the registration desk, food service, water and refreshments, stage support, the cultural program, Bathukamma receiving and transport, Bathukamma line formation, Nimajjanam (immersion) support, and parking. Pick your preference under 'Where would you like to help?' — final assignments are made on the day based on where help is needed, so please be flexible."
  },
  {
    triggers: ['hours', 'how many hours', 'time', 'how long'],
    answer: "Enter how many hours you can volunteer (whole or half hours) and pick the time of day that suits you. Volunteer hours run 9 AM – 10 PM EST; any amount helps."
  },
  {
    triggers: ['supervisor', 'who is supervisor', 'supervisor contact'],
    answer: "You don't need to name a supervisor — the GTA team assigns one before the event and tells you by email."
  },
  {
    triggers: ['description', 'what to write', 'describe', 'what do i put'],
    answer: "There's no description box any more — just pick where you'd like to help from the list, or leave it as 'Anywhere needed'."
  },
  {
    triggers: ['school', 'which school', 'my school'],
    answer: "Just write the name of the school you currently attend (e.g., 'Lincoln Middle School'). GTA asks so they know which schools their volunteers are coming from."
  },
  {
    triggers: ['medical', 'allergy', 'medication', 'optional', 'allergies'],
    answer: "The allergy / medical box is optional but helpful — mention any food allergies or medication you carry so GTA can keep you safe. Leave it blank if none."
  },
  {
    triggers: ['student id', 'id number'],
    answer: "The form doesn't ask for a student ID — just your name, grade and school."
  },
  {
    triggers: ['language', 'telugu', 'english', 'speak'],
    answer: "You don't need to speak Telugu to volunteer! Many roles (registration, food service, kids' activities, cleanup) work great in English. If you do speak Telugu or Hindi, tell the GTA team on the day — bilingual volunteers are a big help."
  },
  {
    triggers: ['food', 'meal', 'eat', 'lunch'],
    answer: "Yes — student volunteers usually get a free meal during their shift. Mention any allergies in the allergy box so GTA can plan for you."
  },
  {
    triggers: ['certificate', 'community service', 'hours certificate', 'proof', 'credit'],
    answer: "Yes — after the event, come back to this app, tap the 'Volunteered Hours' tab, and log how many hours you actually volunteered. You'll get a GTA certificate PDF that you can show your school for community-service credit."
  },
  {
    triggers: ['submit hours', 'log hours', 'after event', 'after volunteering', 'how do i log', 'record my hours'],
    answer: "After you've volunteered, open the app again and tap the '⏱️ Volunteered Hours' tab at the top. Enter the email and last name you used to register, the hours you volunteered, and a quick note. We'll match you to your registration and update GTA's records automatically."
  },
  {
    triggers: ["can't find", "couldn't find", 'no registration', 'cannot find', 'not found', 'didn\'t find'],
    answer: "If the app says it can't find your registration, double-check that the email and last name match exactly what you used to sign up. If you forgot, check the confirmation email (students: your parent received it)."
  },
  {
    triggers: ['offline', 'no internet', 'wifi'],
    answer: "No problem! The form works offline. Your registration saves on your device and is sent to GTA automatically once you're back online."
  },
  {
    triggers: ['pdf', 'report', 'receipt', 'download', 'copy'],
    answer: "When you submit, a PDF copy of your registration downloads to your device — keep it as your receipt. GTA also gets a copy automatically."
  },
  {
    triggers: ['friend', 'with my friend', 'together'],
    answer: "Volunteering with friends is encouraged! Each person needs to fill out their own form (with their own parent consent), but you can ask GTA to assign you to the same role/shift in the description box."
  },
  {
    triggers: ['cancel', 'change my mind', 'cant come', "can't come"],
    answer: "If your plans change, just email the GTA team — your contact info goes to them when you submit. They'll understand. The earlier you let them know, the better."
  },
  {
    triggers: ['email', 'didnt get email', "didn't get email", 'no email', 'confirmation email', 'check email'],
    answer: "After you submit, GTA sends a confirmation email to the email you registered with (and CCs your parent). If you don't see it within a few minutes, check your spam/junk folder. If it's still missing, the email address might have a typo — re-register or contact GTA."
  }
];

/* ----------------------- UI helpers ----------------------- */
function openChat() {
  chatPanel.classList.add('open');
  chatFab.style.display = 'none';
  if (chatMessages.children.length === 0) {
    showBotMessage("Namaste! 🙏 I'm the GTA volunteer helper. Ask me anything about signing up to volunteer at GTA Bathukamma 2026 — what roles are available, what to put in each field, or what to expect on the day.", true);
  }
  setTimeout(() => chatInput.focus(), 100);
}
function closeChat() {
  chatPanel.classList.remove('open');
  chatFab.style.display = 'flex';
}
function appendMessage(text, role, meta) {
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  div.textContent = text;

  // Add a "peek behind the curtain" 🔍 button on bot messages so students
  // can see the system prompt + raw response. Demystifies AI.
  if (role === 'bot' && meta) {
    const peekWrap = document.createElement('div');
    peekWrap.className = 'chat-peek-wrap';
    peekWrap.innerHTML = `
      <button type="button" class="chat-peek-btn" title="How did this AI answer?">🔍 How did the AI answer this?</button>
      <div class="chat-peek-panel" hidden>
        <div class="peek-row"><strong>Source:</strong> ${meta.source}</div>
        ${meta.model ? `<div class="peek-row"><strong>Model:</strong> ${meta.model}</div>` : ''}
        ${meta.systemPrompt ? `<details><summary>System prompt (the rules the AI follows)</summary><pre>${escapeHtmlChat(meta.systemPrompt)}</pre></details>` : ''}
        ${meta.userMessage ? `<details><summary>Your question (sent to the AI)</summary><pre>${escapeHtmlChat(meta.userMessage)}</pre></details>` : ''}
        ${meta.response ? `<details><summary>Raw AI response (before being shown to you)</summary><pre>${escapeHtmlChat(meta.response)}</pre></details>` : ''}
        <p class="peek-takeaway">${meta.lesson || 'AI is just text in, text out. The prompt shapes everything you see.'}</p>
      </div>
    `;
    div.appendChild(peekWrap);
    const pBtn = peekWrap.querySelector('.chat-peek-btn');
    const pPanel = peekWrap.querySelector('.chat-peek-panel');
    pBtn.addEventListener('click', () => { pPanel.hidden = !pPanel.hidden; });
  }

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function escapeHtmlChat(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function showBotMessage(text, withSuggestions = false, meta) {
  appendMessage(text, 'bot', meta || {
    source: 'Built-in greeting (not from an AI model)',
    lesson: 'Not every chat reply uses AI — sometimes a fixed greeting is enough. Knowing when to use AI vs. a hard-coded answer is part of being a good engineer.'
  });
  if (withSuggestions) {
    const suggestions = ['What volunteer roles are available?', 'Do I need parent consent?', 'Will I get a community-service certificate?'];
    const wrap = document.createElement('div');
    wrap.className = 'chat-suggestions';
    suggestions.forEach(s => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = s;
      b.onclick = () => sendUserMessage(s);
      wrap.appendChild(b);
    });
    chatMessages.appendChild(wrap);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}
function showTyping() {
  const div = document.createElement('div');
  div.className = 'chat-msg typing';
  div.id = 'typingIndicator';
  div.textContent = 'thinking…';
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function hideTyping() {
  const t = document.getElementById('typingIndicator');
  if (t) t.remove();
}

/* ----------------------- Built-in FAQ matcher ----------------------- */
function findFaqAnswer(question) {
  const q = question.toLowerCase();
  // Score each FAQ by trigger matches
  let best = null;
  let bestScore = 0;
  for (const item of BUILTIN_FAQ) {
    const score = item.triggers.filter(t => q.includes(t)).length;
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore > 0 ? best.answer : null;
}

/* ----------------------- Groq API call (proxied through Apps Script) ----------------------- */
let lastReplyMeta = {};

async function askGroq(userMessage) {
  conversation.push({ role: 'user', content: userMessage });
  // Cap history at last 10 turns to keep context small
  const recent = [conversation[0], ...conversation.slice(-9)];
  const modelName = 'llama-3.1-8b-instant';

  // Calls the GTA Apps Script proxy, which forwards to Groq using a server-side key.
  // The Groq API key is NOT in the browser anymore.
  const res = await fetchWithRetry(CONFIG.appsScriptUrl, {
    method: 'POST',
    mode: 'cors',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      action: 'proxyGroq',
      sessionId: (typeof getAiSessionId === 'function' ? getAiSessionId() : 'chat'),
      messages: recent,
      temperature: 0.5,
      maxTokens: 220
    })
  }, { maxAttempts: 2, timeoutMs: 25000 });
  if (!res.ok) throw new Error('Proxy: ' + res.status);
  const data = await res.json();
  if (data.status !== 'ok') throw new Error(data.message || 'Proxy error');
  const reply = (data.reply || '').trim();
  if (!reply) throw new Error('No reply from proxy');
  conversation.push({ role: 'assistant', content: reply });

  lastReplyMeta = {
    source: 'Live AI response (via GTA Apps Script proxy → Groq)',
    model: modelName,
    systemPrompt: SYSTEM_PROMPT,
    userMessage: userMessage,
    response: reply,
    lesson: "AI is text-in, text-out. Your message went to GTA's server first (so the API key stays private), which forwarded it to Groq. The system prompt above defines the AI's personality."
  };
  return reply;
}

/* ----------------------- Main message handler ----------------------- */
async function sendUserMessage(text) {
  if (!text || !text.trim()) return;
  appendMessage(text, 'user');
  chatInput.value = '';
  showTyping();

  try {
    let reply;
    lastReplyMeta = {}; // clear from previous turn
    const hasProxy = CONFIG.appsScriptUrl
                  && CONFIG.appsScriptUrl.length > 20
                  && !CONFIG.appsScriptUrl.includes('YOUR_APPS_SCRIPT_URL');
    if (hasProxy && navigator.onLine) {
      try {
        reply = await askGroq(text);
      } catch (apiErr) {
        // If Groq fails (rate limit, network, bad key), fall back to FAQ
        console.warn('Groq fallback:', apiErr);
        reply = findFaqAnswer(text)
          || "I'm having trouble reaching my AI brain right now. Try one of the suggested questions, or check the form's section labels — they explain each field.";
        lastReplyMeta = {
          source: 'FAQ fallback (AI was unreachable)',
          userMessage: text,
          response: reply,
          lesson: 'A good app handles failure gracefully. When the AI is down, the chat falls back to pre-written answers so students still get help.'
        };
      }
    } else {
      // No API key configured — use FAQ
      reply = findFaqAnswer(text)
        || "I can answer common questions about the form — try asking about parent consent, what counts as volunteer hours, or what to write in the description.";
    }

    hideTyping();
    // Build meta for peek-behind-the-curtain
    const meta = lastReplyMeta.source ? lastReplyMeta : {
      source: 'Built-in FAQ (no AI model used for this answer)',
      lesson: 'When the question matches a FAQ keyword, the app skips the AI entirely and uses a pre-written answer. Faster, free, and private.'
    };
    appendMessage(reply, 'bot', meta);
  } catch (err) {
    hideTyping();
    appendMessage("Something went wrong. Please try again.", 'bot', { source: 'Error fallback' });
    console.error(err);
  }
}

/* ----------------------- Wire up events ----------------------- */
chatFab.addEventListener('click', openChat);
chatClose.addEventListener('click', closeChat);
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendUserMessage(chatInput.value);
});
