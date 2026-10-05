/* ============================================================
   AI FEATURES — Quick-win demos that show students what AI can do
   --------------------------------------------------------------
   1. Voice-fill the form (speech → Groq → structured extraction)
   2. Smart role recommendation (description → role match)
   3. Live translator (page header + chat greeting)
   --------------------------------------------------------------
   All three are POWERED BY THE SAME GROQ FREE-TIER KEY in config.js.
   If the key is missing, each feature degrades gracefully.
   ============================================================ */

/* All AI calls go through the GTA Apps Script proxy — the Groq API key
   stays on the server, never in the browser. */
const GROQ_MODEL = 'llama-3.1-8b-instant';

// Get or create a per-tab session ID for rate-limiting (server-side)
function getAiSessionId() {
  try {
    let id = sessionStorage.getItem('aiSessionId');
    if (!id) {
      id = 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 10);
      sessionStorage.setItem('aiSessionId', id);
    }
    return id;
  } catch (e) {
    return 'sess-' + Date.now();
  }
}

function hasGroqKey() {
  // After migration, "having AI" means having the Apps Script URL configured.
  // The actual Groq key now lives only in the Apps Script.
  return CONFIG.appsScriptUrl
      && CONFIG.appsScriptUrl.length > 20
      && !CONFIG.appsScriptUrl.includes('YOUR_APPS_SCRIPT_URL');
}

async function callGroq(messages, opts = {}) {
  // Uses the global fetchWithRetry from app.js (retries on weak networks).
  const fetcher = (typeof fetchWithRetry === 'function') ? fetchWithRetry : fetch;
  const res = await fetcher(CONFIG.appsScriptUrl, {
    method: 'POST',
    mode: 'cors',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      action: 'proxyGroq',
      sessionId: getAiSessionId(),
      messages: messages,
      temperature: opts.temperature ?? 0.2,
      maxTokens: opts.max_tokens ?? 400
    })
  }, { maxAttempts: 2, timeoutMs: 25000 });
  if (!res.ok) throw new Error('Proxy: ' + res.status);
  const data = await res.json();
  if (data.status !== 'ok') throw new Error(data.message || 'Proxy returned error');
  return data.reply || '';
}

/* ============================================================
   1) VOICE-FILL THE FORM
   ============================================================ */
(function setupVoiceFill() {
  // Disabled for the simplified sign-up form (it is short enough to type, and the
  // voice parser targeted fields that no longer exist). Set to true to bring it back.
  const ENABLE_VOICE_FILL = false;
  if (!ENABLE_VOICE_FILL) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const targetForm = document.getElementById('volunteerForm');
  if (!targetForm) return;

  // Insert button at the top of the form
  const wrap = document.createElement('div');
  wrap.id = 'voiceFillWrap';
  wrap.innerHTML = `
    <button type="button" id="voiceFillBtn" class="ai-feature-btn">
      🎤 <span class="lbl">Speak to fill the form</span>
    </button>
    <button type="button" id="voicePeekBtn" class="ai-peek-btn" title="How does this work?">🔍</button>
    <div id="voicePeekPanel" class="ai-peek-panel" hidden></div>
    <p class="mic-note">📱 Allow mic access when prompted (Chrome / Safari · works on phones too).</p>
  `;
  targetForm.insertBefore(wrap, targetForm.firstChild);

  const btn = document.getElementById('voiceFillBtn');
  const peekBtn = document.getElementById('voicePeekBtn');
  const peekPanel = document.getElementById('voicePeekPanel');

  if (!SR) {
    btn.disabled = true;
    btn.querySelector('.lbl').textContent = 'Voice-fill not supported in this browser';
    btn.style.opacity = '0.6';
    return;
  }
  if (!hasGroqKey()) {
    btn.disabled = true;
    btn.querySelector('.lbl').textContent = 'Voice-fill needs Groq key in config.js';
    btn.style.opacity = '0.6';
    return;
  }

  let recognition;
  let isRecording = false;

  // Pick the best recognition language for the audience. Indian English first,
  // then user's browser locale, then US English.
  function pickRecognitionLang() {
    const browserLang = (navigator.language || 'en-US');
    if (browserLang.startsWith('en')) return 'en-IN'; // GTA audience benefits from Indian English
    return browserLang;
  }

  function ensureRecognition() {
    if (recognition) return recognition;
    recognition = new SR();
    recognition.lang = pickRecognitionLang();
    recognition.continuous = false;
    recognition.interimResults = true;   // show partial transcript while speaking
    recognition.maxAlternatives = 3;
    return recognition;
  }

  // Map raw Speech API error codes to friendly, actionable messages
  function friendlyErrorMessage(errCode) {
    const map = {
      'no-speech':            "🤐 I didn't hear anything. Tap and speak clearly when the button turns red.",
      'audio-capture':        "🎤 No microphone detected. Check that your device's mic is connected and not muted.",
      'not-allowed':          "🚫 Microphone access blocked. Click the lock icon in the address bar → allow microphone, then try again.",
      'service-not-allowed':  "🚫 Microphone access blocked by your browser settings. Allow it and try again.",
      'network':              "📡 Voice recognition needs internet. Check your connection and retry.",
      'aborted':              "Stopped. Tap to try again.",
      'language-not-supported': "🌐 Your browser doesn't support voice recognition. Chrome works best.",
      'bad-grammar':          "Voice format error. Tap to try again."
    };
    return map[errCode] || ("Voice error (" + errCode + "). Tap to try again.");
  }

  let lastPromptUsed = '';
  let lastTranscript = '';
  let lastResponse = '';
  let autoRetryAttempted = false;

  // Pre-flight: warn if not on HTTPS (browsers block mic on http://)
  if (location.protocol !== 'https:'
      && location.hostname !== 'localhost'
      && location.hostname !== '127.0.0.1') {
    btn.disabled = true;
    btn.querySelector('.lbl').textContent = '🎤 Voice needs HTTPS — host on GitHub Pages or Netlify';
    btn.style.opacity = '0.6';
    btn.title = 'Web browsers only allow microphone access on HTTPS sites or localhost.';
    return;
  }

  function resetButton(delay) {
    setTimeout(() => {
      btn.querySelector('.lbl').textContent = '🎤 Speak to fill the form';
      btn.classList.remove('recording');
      isRecording = false;
    }, delay || 0);
  }

  function startListening() {
    const r = ensureRecognition();
    isRecording = true;
    autoRetryAttempted = false;
    btn.classList.add('recording');
    btn.querySelector('.lbl').textContent = '🔴 Listening… speak now (name, school, parent, role…)';

    try {
      r.start();
    } catch (e) {
      // Already started — abort and restart
      try { r.abort(); r.start(); } catch (ee) { console.warn(ee); }
    }

    r.onresult = async (e) => {
      // Walk results — show interim, process when final
      let interim = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) final += res[0].transcript;
        else interim += res[0].transcript;
      }
      if (interim && !final) {
        // Live preview while user is still speaking
        const preview = interim.length > 60 ? interim.substring(0, 60) + '…' : interim;
        btn.querySelector('.lbl').textContent = '🎙 "' + preview + '"';
        return;
      }
      if (!final) return;

      lastTranscript = final;
      btn.querySelector('.lbl').textContent = '🤖 Understanding "' + (final.length > 40 ? final.substring(0, 40) + '…' : final) + '"';
      try {
        const fields = await extractFields(final);
        const filled = applyFields(fields);
        btn.querySelector('.lbl').textContent = '✅ Filled ' + filled + ' field' + (filled !== 1 ? 's' : '') + ' — review & submit';
        if (typeof showToast === 'function') {
          showToast('AI heard you and filled ' + filled + ' fields. Check them before submitting.');
        }
      } catch (err) {
        console.error('Voice extract error:', err);
        btn.querySelector('.lbl').textContent = '❌ Could not parse what was heard — try speaking more slowly';
      }
      resetButton(4500);
    };

    r.onerror = (e) => {
      const errCode = (e && e.error) || 'unknown';
      console.warn('Speech recognition error:', errCode);

      // Auto-retry once on "no-speech" (user might have been startled by the button color change)
      if (errCode === 'no-speech' && !autoRetryAttempted) {
        autoRetryAttempted = true;
        btn.querySelector('.lbl').textContent = '🤐 Didn\'t hear you — listening again, speak now';
        try { r.start(); } catch (ee) { resetButton(0); }
        return;
      }

      btn.querySelector('.lbl').textContent = friendlyErrorMessage(errCode);
      resetButton(5500);
    };

    r.onend = () => {
      // If we're still flagged as recording and no final result came, the API ended quietly
      if (isRecording) {
        btn.classList.remove('recording');
        isRecording = false;
      }
    };
  }

  btn.addEventListener('click', () => {
    if (isRecording) return;
    startListening();
  });

  // Peek behind the curtain
  peekBtn.addEventListener('click', () => {
    peekPanel.hidden = !peekPanel.hidden;
    if (!peekPanel.hidden) {
      peekPanel.innerHTML = `
        <strong>How this AI works:</strong>
        <p style="margin: 8px 0;">When you press the mic, the browser's built-in speech recognition turns your voice into text. That text is sent to a free AI model (Llama 3 via Groq), along with a prompt asking it to extract specific fields and return them as JSON. The form is then filled in. <em>That's it</em> — speech recognition + a structured prompt.</p>
        <details style="margin-top: 8px;"><summary>See the prompt that does the work</summary>
        <pre style="white-space: pre-wrap; font-size: 11px; background: #f5f7fb; padding: 8px; border-radius: 4px; margin-top: 6px;">${escapeHtml(buildExtractPrompt('[your spoken introduction]'))}</pre></details>
        ${lastTranscript ? `<details style="margin-top: 8px;"><summary>What you said last time</summary><pre style="white-space: pre-wrap; font-size: 11px; background: #f5f7fb; padding: 8px; border-radius: 4px; margin-top: 6px;">${escapeHtml(lastTranscript)}</pre></details>` : ''}
        ${lastResponse ? `<details style="margin-top: 8px;"><summary>What the AI returned</summary><pre style="white-space: pre-wrap; font-size: 11px; background: #f5f7fb; padding: 8px; border-radius: 4px; margin-top: 6px;">${escapeHtml(lastResponse)}</pre></details>` : ''}
        <p style="margin: 12px 0 0; font-size: 12px; color: #6b7280;"><strong>Want to build something like this?</strong> Search "Web Speech API" + "OpenAI structured output". You can do it in an afternoon.</p>
      `;
    }
  });

  function buildExtractPrompt(transcript) {
    return `You extract structured data from a student's spoken introduction for a volunteer form.

Return ONLY valid JSON. Use empty string for any field not mentioned. Keys allowed: firstName, lastName, gradeLevel (one of: "6th Grade","7th Grade","8th Grade","9th Grade","10th Grade","11th Grade","12th Grade"), schoolName, studentEmail, studentPhone, parentName, parentEmail, parentPhone, hours, allergies, medicalConditions, medications, description, activityName (one of: "Registration desk","Cultural program help","Food service","Stage crew","Parking","Other").

Student said: "${transcript}"

JSON:`;
  }

  async function extractFields(transcript) {
    lastPromptUsed = buildExtractPrompt(transcript);
    const text = await callGroq([{ role: 'user', content: lastPromptUsed }], { temperature: 0.1, max_tokens: 500 });
    lastResponse = text;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in AI response');
    return JSON.parse(match[0]);
  }

  function applyFields(fields) {
    let filled = 0;
    Object.keys(fields).forEach((k) => {
      const v = fields[k];
      if (!v) return;
      const el = document.querySelector(`[name="${k}"]`);
      if (!el) return;
      if (el.tagName === 'SELECT') {
        const opt = Array.from(el.options).find(o =>
          o.value.toLowerCase() === String(v).toLowerCase() ||
          o.textContent.toLowerCase() === String(v).toLowerCase()
        );
        if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); filled++; }
      } else if (!el.readOnly && el.type !== 'hidden') {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        filled++;
      }
    });
    return filled;
  }
})();

/* ============================================================
   2) SMART ROLE RECOMMENDATION
   ============================================================ */
(function setupRoleRecommend() {
  const desc = document.getElementById('description');
  const roleSelect = document.getElementById('activityName');
  if (!desc || !roleSelect) return;
  if (!hasGroqKey()) return;

  const ROLE_LIST = ['Anywhere needed', 'Registration & check-in desk', 'Food service', 'Water & refreshments', 'Stage support', 'Cultural program support', 'Bathukamma receiving & transport', 'Bathukamma line formation', 'Nimajjanam (immersion) support', 'Parking & traffic'];

  // Build a recommendation panel below the description field
  const panel = document.createElement('div');
  panel.id = 'roleRecommendPanel';
  panel.className = 'role-recommend';
  panel.hidden = true;
  desc.parentNode.insertAdjacentElement('afterend', panel);

  let timer = null;
  let lastSeen = '';

  desc.addEventListener('input', () => {
    const text = desc.value.trim();
    clearTimeout(timer);
    if (text.length < 30) { panel.hidden = true; return; }
    if (text === lastSeen) return;
    timer = setTimeout(async () => {
      lastSeen = text;
      try {
        const suggestion = await getRoleSuggestion(text);
        if (!suggestion) return;
        if (suggestion.role === roleSelect.value) { panel.hidden = true; return; }
        panel.hidden = false;
        panel.innerHTML = `
          <div class="rr-content">
            <strong>🤖 AI suggestion</strong>: based on what you wrote, you might enjoy <strong>${escapeHtml(suggestion.role)}</strong>.
            ${suggestion.why ? `<div class="rr-why">${escapeHtml(suggestion.why)}</div>` : ''}
          </div>
          <div class="rr-actions">
            <button type="button" class="rr-accept">Switch to "${escapeHtml(suggestion.role)}"</button>
            <button type="button" class="rr-dismiss">No thanks</button>
            <button type="button" class="rr-peek" title="How does this work?">🔍</button>
          </div>
          <div class="rr-peek-panel" hidden>
            <p><strong>How this works:</strong> Each time you stop typing in the description box, the text is sent to an AI model with a list of available roles and a prompt asking which role best matches. The AI's response is parsed and shown above.</p>
            <p style="font-size: 12px; color: #6b7280; margin-top: 8px;">This is the same pattern used by AI resume screeners and job-matching sites.</p>
          </div>
        `;
        panel.querySelector('.rr-accept').onclick = () => acceptRole(suggestion.role);
        panel.querySelector('.rr-dismiss').onclick = () => { panel.hidden = true; };
        panel.querySelector('.rr-peek').onclick = () => {
          const p = panel.querySelector('.rr-peek-panel');
          p.hidden = !p.hidden;
        };
      } catch (e) {
        console.warn('Role recommend skipped:', e);
      }
    }, 1500);
  });

  function acceptRole(role) {
    const opt = Array.from(roleSelect.options).find(o =>
      o.value.toLowerCase() === role.toLowerCase() || o.textContent.toLowerCase() === role.toLowerCase()
    );
    if (opt) {
      roleSelect.value = opt.value;
      roleSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    panel.hidden = true;
  }

  async function getRoleSuggestion(text) {
    const prompt = `A student wrote this in their volunteer notes: "${text}"

Available roles for the GTA Bathukamma: ${ROLE_LIST.join(', ')}.

Pick the SINGLE best-fit role for them. Return ONLY a JSON object with exactly two keys:
{"role": "exact role name from the list", "why": "very short reason in one sentence under 80 characters"}`;
    const txt = await callGroq([{ role: 'user', content: prompt }], { temperature: 0.4, max_tokens: 120 });
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    if (!ROLE_LIST.includes(obj.role)) return null;
    return obj;
  }
})();

/* ============================================================
   3) LIVE TRANSLATOR (header + chat greeting demo)
   ============================================================ */
(function setupTranslator() {
  if (!hasGroqKey()) return;

  const LANGS = [
    { code: 'en', label: 'English', flag: '🇺🇸' },
    { code: 'te', label: 'తెలుగు', flag: '🇮🇳' },
    { code: 'hi', label: 'हिन्दी', flag: '🇮🇳' },
    { code: 'es', label: 'Español', flag: '🇪🇸' },
    { code: 'zh', label: '中文', flag: '🇨🇳' }
  ];

  // Insert language picker below the banner — hidden until parent email is verified
  const main = document.querySelector('main');
  const picker = document.createElement('div');
  picker.id = 'langPicker';
  picker.className = 'lang-picker';
  picker.style.display = 'none';
  picker.innerHTML = `
    <span style="font-size: 12px; color: var(--muted); margin-right: 6px;">🌐 Language:</span>
    ${LANGS.map(l => `<button type="button" data-lang="${l.code}" class="lang-btn${l.code === 'en' ? ' active' : ''}">${l.flag} ${l.label}</button>`).join('')}
    <button type="button" id="langPeekBtn" class="ai-peek-btn" title="How this works">🔍</button>
    <div id="langPeekPanel" class="ai-peek-panel" hidden>
      <p><strong>How this works:</strong> the page text is sent to an AI translation model in one batch. The model returns the same text in the target language, and the page swaps it in. Every word you see has just been translated by AI in real time.</p>
      <p style="font-size: 12px; color: #6b7280;">This is the same model family that powers Google Translate's neural translation, Duolingo, and live captions.</p>
    </div>
  `;
  main.insertBefore(picker, main.firstChild);

  // Targets we'll translate. We deliberately skip <input> values, field names,
  // and the form's submit button, so the data submitted stays in English.
  const targets = [
    document.querySelector('header h1'),
    document.querySelector('header .subtitle'),
    document.querySelector('header .tagline'),
    document.getElementById('tabRegister'),
    document.getElementById('tabHours')
  ].filter(Boolean);

  // Cache originals
  const originalText = new Map();
  targets.forEach(el => originalText.set(el, el.textContent.trim()));

  // Cache translations so toggling is instant after first switch
  const cache = { en: targets.map(el => originalText.get(el)) };

  picker.addEventListener('click', async (e) => {
    const btn = e.target.closest('.lang-btn');
    if (!btn) return;
    picker.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const lang = btn.dataset.lang;

    if (cache[lang]) {
      apply(cache[lang]);
      return;
    }

    btn.disabled = true;
    btn.style.opacity = '0.6';
    try {
      const translations = await translateBatch(targets.map(el => originalText.get(el)), btn.textContent.trim());
      cache[lang] = translations;
      apply(translations);
    } catch (err) {
      console.error('Translate failed:', err);
      alert('Translation failed. Try another language.');
    } finally {
      btn.disabled = false;
      btn.style.opacity = '1';
    }
  });

  document.getElementById('langPeekBtn').addEventListener('click', () => {
    const p = document.getElementById('langPeekPanel');
    p.hidden = !p.hidden;
  });

  function apply(translations) {
    targets.forEach((el, i) => { if (translations[i]) el.textContent = translations[i]; });
  }

  async function translateBatch(strings, targetLangLabel) {
    const numbered = strings.map((s, i) => `${i + 1}. ${s}`).join('\n');
    const prompt = `Translate the following ${strings.length} short UI strings into ${targetLangLabel}. Keep punctuation, casing style, and meaning. Do not transliterate brand names like "GTA" or "Global Telangana Association" — leave those in English. Return a JSON array of strings, in the same order as the input.

Input:
${numbered}

JSON array:`;
    const txt = await callGroq([{ role: 'user', content: prompt }], { temperature: 0.2, max_tokens: 600 });
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('No JSON array in AI translation');
    return JSON.parse(m[0]);
  }
})();

/* ============================================================
   Shared helpers
   ============================================================ */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
