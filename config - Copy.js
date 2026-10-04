/* ============================================================
   App Configuration
   --------------------------------------------------------------
   This is the ONLY file your school admin needs to edit.
   After deploying the Apps Script web app (see SETUP.md),
   paste the deployment URL into appsScriptUrl below.
   ============================================================ */

const CONFIG = {
  // --- Google Sheets sync ---
  // Paste your Apps Script web-app URL here. It will look like:
  // https://script.google.com/macros/s/AKfycb.../exec
  appsScriptUrl: 'https://script.google.com/macros/s/AKfycbwvmsRNlEUVkU-pFadXzPabLsT1A1FS90JzLdrl9R1Ovqoubtz1gIveAJIwv1C6N39htw/exec',

  // --- AI Chat Assistant ---
  // LEGACY FIELD (no longer used by the browser) — kept for backward compatibility.
  // AI calls are now PROXIED through the Apps Script (see GTA_CONFIG.groqApiKey
  // in apps-script-backend.gs). The real Groq key lives only on the server.
  // This value can be safely cleared. The browser ignores it.
  groqApiKey: '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',

  // School name shown in the QR poster (optional)
  schoolDisplayName: 'Our School'
};
