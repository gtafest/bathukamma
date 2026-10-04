/* ============================================================
   GOOGLE APPS SCRIPT — GTA International Fest Volunteer Backend
   --------------------------------------------------------------
   Handles TWO kinds of submission:
     1) New registration → appends a new row with all student info
     2) Hours-completed submission → finds the student's existing
        row by email + last name, fills in actual hours/notes/timestamp,
        and highlights the row green so GTA can see who completed.

   How to deploy (one-time setup, ~5 min — done by a GTA admin):
     1) Create a new Google Sheet in your GTA account.
        Suggested name: "GTA International Fest — Volunteer Registrations"
     2) In the Sheet menu: Extensions → Apps Script
     3) Delete the default code, paste THIS ENTIRE FILE in
     4) Click Save (disk icon), name the project "GTA Volunteer Backend"
     5) Click Deploy → New deployment
          - Type: Web app
          - Description: GTA Volunteer Form Backend
          - Execute as: Me
          - Who has access: Anyone
        Click Deploy. Authorize when prompted.
     6) Copy the "Web app URL" it shows you (ends in /exec)
     7) Paste that URL into config.js  →  appsScriptUrl
     8) Done!

   IMPORTANT: If you already deployed an older version, redeploy:
     Deploy → Manage deployments → pick your deployment → edit (✏️)
     → Version: New version → Deploy. The URL stays the same.
   ============================================================ */

/* ============================================================
   ADMIN PIN — change this to a strong PIN before deploying.
   The admin dashboard at admin.html requires this PIN to view stats.
   Anyone who knows the PIN can read aggregated stats (no edits).
   Recommended: 8+ characters, mix of letters and numbers.
   ============================================================ */
const ADMIN_PIN = 'CHANGE-ME-12345';

/* ============================================================
   GTA EVENT CONFIG — used in confirmation emails.
   Edit these values so emails sent to students/parents are
   branded correctly for your event.
   ============================================================ */
const GTA_CONFIG = {
  // Display name shown in the "From" field (alongside the GTA admin's email)
  senderName: 'Global Telangana Association',

  // Where students/parents reply if they have questions
  contactEmail: 'volunteers@gta.example.org',

  // Optional: when known, set this to the actual event date — appears in the email
  eventDate: 'Saturday, June 6, 2026 (3:00 PM – 9:00 PM EST)',

  // Optional: a website link for more info
  eventWebsiteUrl: '',  // e.g., 'https://gta-fest.example.org'

  // Set to false to disable confirmation emails entirely
  sendConfirmationEmails: true,

  // Free Groq API key (from console.groq.com/keys) — used to generate
  // personalized welcome letters and appreciation messages.
  // Leave as 'YOUR_GROQ_KEY_HERE' to disable AI personalization (emails
  // still send, just without the AI-written sections).
  groqApiKey: 'YOUR_GROQ_KEY_HERE',

  // --- Email verification gate ---
  // When true, the form is locked until the parent's email is verified
  // via a 6-digit code. Strongly recommended for COPPA-compliant
  // collection of minors' data.
  requireEmailVerification: true,

  // --- Public app URL (used to build the QR-code link) ---
  // Where checkin.html / index.html are hosted publicly. Must end with a slash.
  // Example: 'https://gtafest.github.io/volunteer-app/'
  // If left as a placeholder, the QR will encode just the token (admin can use
  // the in-app scanner inside checkin.html instead).
  appBaseUrl: 'https://YOUR-USERNAME.github.io/YOUR-REPO/'
};

// Header row written automatically the first time data arrives.
// Three columns at the end (in CAPS comment) are filled in by the
// hours-completion submission — they stay blank until the kid logs hours.
const HEADERS = [
  'Submitted At', 'Submission ID',
  'First Name', 'Last Name', 'Date of Birth', 'Grade Level',
  'School Name', 'Student ID', 'Student Email', 'Student Phone',
  'Parent/Guardian Name', 'Relationship', 'Parent Email', 'Parent Phone',
  'Emergency Contact Name', 'Emergency Contact Phone', 'Parent Consent',
  'Volunteer Role', 'Organization', 'Activity Date', 'Hours Pledged',
  'Supervisor Name', 'Supervisor Contact', 'Description',
  'Allergies', 'Medical Conditions', 'Medications',
  // ---- Filled in later when the student logs completed hours ----
  'Actual Hours Completed', 'Hours Submitted At', 'Volunteer Notes', 'Hours Receipt ID',
  // ---- Per-row deletion token (used by self-service "delete my registration" link) ----
  'Deletion Token',
  // ---- Volunteer-type flags (so GTA can filter student vs adult registrations) ----
  'Is Student?', 'Adult Consent',
  // ---- Event-day check-in (admin scans the volunteer's QR code at the registration desk) ----
  'Check-in Token', 'Checked In At', 'Checked In By',
  // ---- Event-day check-OUT (admin scans the QR again when the volunteer leaves) ----
  // Verified Duration is the difference between check-in and check-out in hours.
  // Hours Status is 'Verified' (claimed ≤ verified), 'Over-claimed', or 'Unverified' (no check-in/out).
  'Checked Out At', 'Checked Out By', 'Verified Duration (hrs)', 'Hours Status',
  // ---- Pre-event team assignment (admin fills "Assigned Team" before the blast goes out) ----
  // Valid values: "DJ Team", "GTA Stall", "Balloon Team", or leave BLANK (default = registration desk).
  // "Pre-event Email Sent" auto-stamps when the email is delivered to prevent double-sends.
  'Assigned Team', 'Pre-event Email Sent',
  // ---- Post-event thank-you blast tracking ----
  // Auto-stamps when sendPostEventThankYou() includes this volunteer in the BCC list,
  // so re-runs only target rows that haven't received the thank-you yet.
  'Post-event Email Sent',
  // ---- 7-day data-retention wipe tracking ----
  // Auto-stamps when wipePiiForRetention() anonymizes the row's PII fields.
  // Once stamped, the row is skipped on subsequent runs (idempotent).
  'PII Wiped At'
];

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.action === 'sendOtp')          return handleSendOtp(data);
    if (data.action === 'verifyOtp')        return handleVerifyOtp(data);
    if (data.action === 'submitHours')      return handleHoursSubmission(data);
    if (data.action === 'getStats')         return handleGetStats(data);
    if (data.action === 'proxyGroq')        return handleProxyGroq(data);
    if (data.action === 'lookupVolunteer')  return handleLookupVolunteer(data);
    if (data.action === 'confirmCheckIn')   return handleConfirmCheckIn(data);
    if (data.action === 'emailCertificate') return handleEmailCertificate(data);
    return handleRegistration(data);
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.toString() });
  }
}

/* ----------------------- New registration ----------------------- */
function handleRegistration(data) {
  // Reject school emails on either field — they block our confirmation mail
  if (isSchoolEmail(data.studentEmail) || isSchoolEmail(data.parentEmail)) {
    return jsonResponse({
      status: 'error',
      message: SCHOOL_EMAIL_REJECT_MESSAGE,
      code: 'school_email'
    });
  }

  // Rate limit: max 5 registrations per email per hour (handles legit retries; blocks spam)
  const emailKey = (data.studentEmail || '') + '|' + (data.parentEmail || '');
  if (!checkRateLimit('reg:' + emailKey, 5, 3600)) {
    return jsonResponse({
      status: 'error',
      message: 'Too many registration attempts from this email recently. Please wait an hour or contact GTA if you need help.'
    });
  }

  // Email verification check — confirm the parent email was OTP-verified
  if (GTA_CONFIG.requireEmailVerification) {
    const token = data._verifiedToken || '';
    const submittedParentEmail = (data.parentEmail || '').toLowerCase().trim();
    const verifiedEmail = token ? CacheService.getScriptCache().get('vtoken:' + token) : null;
    if (!verifiedEmail || verifiedEmail !== submittedParentEmail) {
      return jsonResponse({
        status: 'error',
        message: 'Parent email verification has expired or does not match. Please verify the parent email again.',
        code: 'verification_expired'
      });
    }
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  ensureHeaders(sheet);

  // Generate a unique deletion token for this row (used by the "delete my registration" link)
  const deletionToken = generateDeletionToken();
  data._deletionToken = deletionToken;
  data._deletionUrl = buildDeletionUrl(deletionToken);

  // Generate a unique check-in token (used at the event-day registration desk)
  const checkInToken = generateCheckInToken();
  data._checkInToken = checkInToken;
  data._checkInQrUrl = buildCheckInQrUrl(checkInToken);

  // Build a column-name → value MAP (not a positional array).
  // This way the row is always written to the correct column, even if the live
  // sheet's column order has drifted from the HEADERS array order.
  const dataMap = {
    'Submitted At':              data.submittedAtReadable || new Date().toLocaleString(),
    'Submission ID':             data.submissionId || '',
    'First Name':                data.firstName || '',
    'Last Name':                 data.lastName || '',
    'Date of Birth':             data.dob || '',
    'Grade Level':               data.gradeLevel || '',
    'School Name':               data.schoolName || '',
    'Student ID':                data.studentId || '',
    'Student Email':             data.studentEmail || '',
    'Student Phone':             data.studentPhone || '',
    'Parent/Guardian Name':      data.parentName || '',
    'Relationship':              data.parentRelation || '',
    'Parent Email':              data.parentEmail || '',
    'Parent Phone':              data.parentPhone || '',
    'Emergency Contact Name':    data.emergencyName || '',
    'Emergency Contact Phone':   data.emergencyPhone || '',
    'Parent Consent':            data.parentConsent ? 'YES' : 'NO',
    'Volunteer Role':            data.activityName || '',
    'Organization':              data.organization || '',
    'Activity Date':             data.activityDate || '',
    'Hours Pledged':             data.hours || '',
    'Supervisor Name':           data.supervisorName || '',
    'Supervisor Contact':        data.supervisorContact || '',
    'Description':               data.description || '',
    'Allergies':                 data.allergies || '',
    'Medical Conditions':        data.medicalConditions || '',
    'Medications':               data.medications || '',
    'Actual Hours Completed':    '',
    'Hours Submitted At':        '',
    'Volunteer Notes':           '',
    'Hours Receipt ID':          '',
    'Deletion Token':            deletionToken,
    'Is Student?':               (data._isStudent === 'no' ? 'No' : 'Yes'),
    'Adult Consent':             (data.adultConsent ? 'YES' : 'NO'),
    'Check-in Token':            checkInToken,
    'Checked In At':             '',
    'Checked In By':             '',
    'Checked Out At':            '',
    'Checked Out By':            '',
    'Verified Duration (hrs)':   '',
    'Hours Status':              'Unverified',
    'Assigned Team':             '',
    'Pre-event Email Sent':      '',
    'Post-event Email Sent':     '',
    'PII Wiped At':              ''
  };

  // Read the SHEET's actual column headers (not HEADERS constant — they may drift)
  const liveHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = liveHeaders.map(function(h) {
    return dataMap[h] !== undefined ? dataMap[h] : '';
  });

  sheet.appendRow(row);

  // Force the write to commit immediately so other admins viewing the sheet
  // see the row right away (without waiting for the script to finish).
  SpreadsheetApp.flush();

  // Fire-and-forget email confirmation — don't fail the registration if email fails
  try {
    sendRegistrationEmail(data);
  } catch (mailErr) {
    Logger.log('Registration email failed: ' + mailErr.toString());
  }

  return jsonResponse({ status: 'ok', submissionId: data.submissionId });
}

/* ----------------------- Hours submission (matches & updates) ----------------------- */
function handleHoursSubmission(data) {
  // Rate limit: 5 hours-submissions per email per hour
  // 20 hours-submissions per email per hour (was 5 — too tight for legitimate retries
  // during testing or for volunteers correcting an over-claimed-hours error)
  if (!checkRateLimit('hrs:' + (data.email || '').toLowerCase(), 20, 3600)) {
    return jsonResponse({
      status: 'error',
      message: 'Too many hours-submission attempts in the last hour. Please wait or contact GTA — or have an admin run clearRateLimits() in the Apps Script editor.'
    });
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  ensureHeaders(sheet);

  const all = sheet.getDataRange().getValues();
  if (all.length < 2) {
    return jsonResponse({
      status: 'error',
      message: "We couldn't find any registrations yet. Please make sure you registered first."
    });
  }

  const headers = all[0];
  const emailCol       = headers.indexOf('Student Email');
  const parentEmailCol = headers.indexOf('Parent Email');
  const lastNameCol    = headers.indexOf('Last Name');
  const firstNameCol   = headers.indexOf('First Name');
  const roleCol        = headers.indexOf('Volunteer Role');
  const hrsCompletedCol = headers.indexOf('Actual Hours Completed');
  const hrsSubmittedAtCol = headers.indexOf('Hours Submitted At');
  const notesCol      = headers.indexOf('Volunteer Notes');
  const receiptIdCol  = headers.indexOf('Hours Receipt ID');
  const checkedInAtCol  = headers.indexOf('Checked In At');
  const checkedOutAtCol = headers.indexOf('Checked Out At');
  const verifiedDurCol  = headers.indexOf('Verified Duration (hrs)');
  const hoursStatusCol  = headers.indexOf('Hours Status');

  if (lastNameCol < 0 || hrsCompletedCol < 0 || (emailCol < 0 && parentEmailCol < 0)) {
    return jsonResponse({
      status: 'error',
      message: 'Sheet is missing required columns. Ask the GTA admin to redeploy the latest backend.'
    });
  }

  // Find matching row. We match against Student Email OR Parent Email — adult
  // volunteers don't have a student email, so their registration email lives
  // in the Parent Email column. Most-recent-first so retries/duplicates use
  // the latest record.
  const targetEmail = (data.email || '').toLowerCase().trim();
  const targetLast  = (data.lastName || '').toLowerCase().trim();
  let matchIdx = -1;
  for (let i = all.length - 1; i >= 1; i--) {
    const rowStudentEmail = emailCol       >= 0 ? String(all[i][emailCol]       || '').toLowerCase().trim() : '';
    const rowParentEmail  = parentEmailCol >= 0 ? String(all[i][parentEmailCol] || '').toLowerCase().trim() : '';
    const rowLast         = String(all[i][lastNameCol] || '').toLowerCase().trim();
    if (rowLast === targetLast && (rowStudentEmail === targetEmail || rowParentEmail === targetEmail)) {
      matchIdx = i;
      break;
    }
  }

  if (matchIdx === -1) {
    return jsonResponse({
      status: 'error',
      message: "We couldn't find a registration with that email and last name. Double-check your spelling, or register first if you haven't yet."
    });
  }

  /* ============================================================
     VERIFICATION GATE — hours must match what the QR scan recorded
     ============================================================
     Rules:
       (a) Volunteer MUST be checked IN by an admin at the event.
       (b) Volunteer MUST be checked OUT by an admin at the event.
       (c) Claimed hours must be ≤ verified duration + 0.5h tolerance
           (small grace so a kid claiming 4h after 3h45m gets through).
     If any rule fails, reject with a clear error message — the volunteer
     can resolve it by finding an admin and getting scanned. */
  const claimedHrs = Number(data.hoursCompleted);
  if (!claimedHrs || claimedHrs <= 0) {
    return jsonResponse({ status: 'error', message: 'Please enter a valid number of hours.' });
  }

  const rowCheckedInAt  = checkedInAtCol  >= 0 ? String(all[matchIdx][checkedInAtCol]  || '').trim() : '';
  const rowCheckedOutAt = checkedOutAtCol >= 0 ? String(all[matchIdx][checkedOutAtCol] || '').trim() : '';
  const rowVerifiedDur  = verifiedDurCol  >= 0 ? Number(all[matchIdx][verifiedDurCol]  || 0)  : 0;

  if (!rowCheckedInAt) {
    return jsonResponse({
      status: 'error',
      code: 'not_checked_in',
      message: "We don't have a record of you checking IN at the event. Please find a GTA admin at the volunteer desk — they'll scan your QR code so your hours can be locked in."
    });
  }
  if (!rowCheckedOutAt) {
    return jsonResponse({
      status: 'error',
      code: 'not_checked_out',
      message: "We have your check-IN but not your check-OUT. Please find a GTA admin before you leave the event — they'll scan your QR code again so your hours can be verified."
    });
  }

  const TOLERANCE_HRS = 0.5; // half-hour grace
  if (claimedHrs > rowVerifiedDur + TOLERANCE_HRS) {
    return jsonResponse({
      status: 'error',
      code: 'over_claimed',
      verifiedDuration: rowVerifiedDur,
      message: `You've entered ${claimedHrs} hours, but our QR scans show you were on-site for ${rowVerifiedDur} hours. Please enter ${rowVerifiedDur} hours (or less). If this is wrong, please contact GTA — we can update the record.`
    });
  }

  const rowNum = matchIdx + 1; // 1-indexed for getRange
  sheet.getRange(rowNum, hrsCompletedCol + 1).setValue(claimedHrs);
  sheet.getRange(rowNum, hrsSubmittedAtCol + 1).setValue(data.submittedAtReadable || new Date().toLocaleString());
  if (hoursStatusCol >= 0) {
    sheet.getRange(rowNum, hoursStatusCol + 1).setValue('Verified');
  }

  // Append notes; if there are already notes, prepend the new ones
  const existingNotes = String(sheet.getRange(rowNum, notesCol + 1).getValue() || '');
  const newNote = (data.dateVolunteered ? `[${data.dateVolunteered}] ` : '') + (data.notes || '');
  const combined = existingNotes
    ? existingNotes + '\n' + newNote
    : newNote;
  sheet.getRange(rowNum, notesCol + 1).setValue(combined);

  if (receiptIdCol >= 0) {
    sheet.getRange(rowNum, receiptIdCol + 1).setValue(data.receiptId || '');
  }

  // Highlight the entire row green so GTA can see at a glance who completed
  sheet.getRange(rowNum, 1, 1, headers.length).setBackground('#d1fae5');
  SpreadsheetApp.flush(); // Push update so other admins see it immediately

  // Build the volunteer record once (used for both AI generation and the email)
  const cParentEmail = headers.indexOf('Parent Email');
  const cSchool      = headers.indexOf('School Name');
  const volunteerRecord = {
    firstName: all[matchIdx][firstNameCol] || '',
    lastName: all[matchIdx][lastNameCol] || '',
    studentEmail: targetEmail,
    parentEmail: cParentEmail >= 0 ? all[matchIdx][cParentEmail] : '',
    role: all[matchIdx][roleCol] || '',
    school: cSchool >= 0 ? all[matchIdx][cSchool] : '',
    hoursCompleted: data.hoursCompleted,
    dateVolunteered: data.dateVolunteered || '',
    notes: data.notes || '',
    receiptId: data.receiptId || ''
  };

  // Generate the AI appreciation (best-effort) — used in BOTH the email and the PDF certificate
  const appreciation = generateAppreciation(volunteerRecord);
  volunteerRecord._aiAppreciation = appreciation;

  // EMAIL STRATEGY:
  //   - If the client signals "_pdfPending: true" (default for the modern app),
  //     we SKIP the immediate text-only thank-you and let the follow-up
  //     emailCertificate call send a SINGLE consolidated email with the
  //     personalized PDF attached + parent CC'd.
  //   - If the client did NOT signal pdfPending (older clients, or PDF
  //     generation failed), we fall back to the standalone text email so
  //     the volunteer at least gets confirmation.
  if (!data._pdfPending) {
    try {
      sendHoursConfirmationEmail(volunteerRecord);
    } catch (mailErr) {
      Logger.log('Hours email failed: ' + mailErr.toString());
    }
  } else {
    Logger.log('Hours email suppressed — client will trigger emailCertificate with PDF attachment.');
  }

  return jsonResponse({
    status: 'ok',
    firstName: all[matchIdx][firstNameCol] || '',
    activityName: all[matchIdx][roleCol] || '',
    appreciation: appreciation || '',  // client uses this in the certificate PDF
    verification: {
      verified: true,
      checkedInAt:  rowCheckedInAt,
      checkedOutAt: rowCheckedOutAt,
      verifiedDuration: rowVerifiedDur,
      claimedHours: claimedHrs
    }
  });
}

/* ----------------------- Admin dashboard stats ----------------------- */
function handleGetStats(data) {
  // Gate by PIN — without this, anyone could read GTA's volunteer list
  if (!data.adminPin || data.adminPin !== ADMIN_PIN) {
    return jsonResponse({ status: 'error', message: 'Invalid admin PIN.' });
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  ensureHeaders(sheet);
  const all = sheet.getDataRange().getValues();
  if (all.length < 2) {
    return jsonResponse({
      status: 'ok',
      stats: emptyStats()
    });
  }

  const headers = all[0];
  const idx = (name) => headers.indexOf(name);

  const cFirst = idx('First Name');
  const cLast  = idx('Last Name');
  const cSchool = idx('School Name');
  const cGrade = idx('Grade Level');
  const cRole  = idx('Volunteer Role');
  const cEmail = idx('Student Email');
  const cSubmittedAt = idx('Submitted At');
  const cHoursPledged = idx('Hours Pledged');
  const cHoursCompleted = idx('Actual Hours Completed');
  const cHoursSubmittedAt = idx('Hours Submitted At');
  const cParentPhone = idx('Parent Phone');

  const rows = all.slice(1);

  const totalRegistered = rows.length;
  let totalCompleted = 0;
  let totalHoursPledged = 0;
  let totalHoursCompleted = 0;
  const bySchool = {};
  const byRole = {};
  const byGrade = {};
  const recent = [];
  const pending = [];

  rows.forEach((r) => {
    const hoursPledged = Number(r[cHoursPledged]) || 0;
    const hoursCompleted = Number(r[cHoursCompleted]) || 0;
    totalHoursPledged += hoursPledged;
    totalHoursCompleted += hoursCompleted;
    if (hoursCompleted > 0) totalCompleted++;

    const school = String(r[cSchool] || '(Unspecified)').trim() || '(Unspecified)';
    const role = String(r[cRole] || '(Unspecified)').trim() || '(Unspecified)';
    const grade = String(r[cGrade] || '(Unspecified)').trim() || '(Unspecified)';
    bySchool[school] = (bySchool[school] || 0) + 1;
    byRole[role] = (byRole[role] || 0) + 1;
    byGrade[grade] = (byGrade[grade] || 0) + 1;
  });

  // Recent registrations — last 10, newest first
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 10); i--) {
    const r = rows[i];
    recent.push({
      submittedAt: String(r[cSubmittedAt] || ''),
      name: `${r[cFirst] || ''} ${r[cLast] || ''}`.trim(),
      school: String(r[cSchool] || ''),
      grade: String(r[cGrade] || ''),
      role: String(r[cRole] || ''),
      hoursPledged: r[cHoursPledged] || '',
      hoursCompleted: r[cHoursCompleted] || ''
    });
  }

  // Pending hours — registered but no hours logged
  rows.forEach((r) => {
    const hoursCompleted = Number(r[cHoursCompleted]) || 0;
    if (hoursCompleted === 0) {
      pending.push({
        name: `${r[cFirst] || ''} ${r[cLast] || ''}`.trim(),
        email: String(r[cEmail] || ''),
        parentPhone: String(r[cParentPhone] || ''),
        school: String(r[cSchool] || ''),
        role: String(r[cRole] || ''),
        hoursPledged: r[cHoursPledged] || ''
      });
    }
  });

  return jsonResponse({
    status: 'ok',
    stats: {
      totalRegistered,
      totalCompleted,
      totalPending: totalRegistered - totalCompleted,
      totalHoursPledged,
      totalHoursCompleted,
      completionRate: totalRegistered > 0 ? Math.round((totalCompleted / totalRegistered) * 100) : 0,
      bySchool: sortDictDesc(bySchool),
      byRole: sortDictDesc(byRole),
      byGrade: sortGrades(byGrade),
      recent,
      pending,
      generatedAt: new Date().toLocaleString()
    }
  });
}

function sortDictDesc(obj) {
  return Object.keys(obj)
    .map(k => ({ label: k, count: obj[k] }))
    .sort((a, b) => b.count - a.count);
}

function sortGrades(obj) {
  // Order grades naturally (6th, 7th, 8th, ..., 12th)
  const order = ['6th Grade','7th Grade','8th Grade','9th Grade','10th Grade','11th Grade','12th Grade'];
  return order
    .filter(g => obj[g])
    .map(g => ({ label: g, count: obj[g] }))
    .concat(
      Object.keys(obj)
        .filter(k => order.indexOf(k) === -1)
        .map(k => ({ label: k, count: obj[k] }))
    );
}

function emptyStats() {
  return {
    totalRegistered: 0, totalCompleted: 0, totalPending: 0,
    totalHoursPledged: 0, totalHoursCompleted: 0, completionRate: 0,
    bySchool: [], byRole: [], byGrade: [], recent: [], pending: [],
    generatedAt: new Date().toLocaleString()
  };
}

/* ----------------------- Header bootstrap (idempotent) ----------------------- */
function ensureHeaders(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length)
         .setFontWeight('bold')
         .setBackground('#0d6efd')
         .setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    return;
  }
  // If old version of the sheet exists without the new "hours" columns, add them
  const existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const newCols = HEADERS.filter((h) => existing.indexOf(h) === -1);
  if (newCols.length > 0) {
    const startCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, startCol, 1, newCols.length).setValues([newCols])
         .setFontWeight('bold')
         .setBackground('#0d6efd')
         .setFontColor('#ffffff');
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   RATE LIMITING — protects against spam / runaway scripts
   --------------------------------------------------------------
   Uses Apps Script's CacheService (max 6 hour TTL, server-side
   memory). Each identifier (email or session token) is allowed
   N requests per window. Returns true if allowed, false if blocked.
   ============================================================ */
function checkRateLimit(identifier, maxPerWindow, windowSeconds) {
  if (!identifier) return true;  // no identifier → can't track, allow
  try {
    const cache = CacheService.getScriptCache();
    const key = 'rl:' + (identifier || '').toString().toLowerCase().substring(0, 100);
    const current = parseInt(cache.get(key) || '0', 10);
    if (current >= maxPerWindow) return false;
    cache.put(key, String(current + 1), windowSeconds);
    return true;
  } catch (e) {
    Logger.log('Rate-limit check failed (allowing request): ' + e.toString());
    return true;
  }
}

/* ============================================================
   ADMIN HELPER — clear rate limits for a specific email (or all)
   --------------------------------------------------------------
   Run from the Apps Script editor (Run → choose function) when:
     - You're testing and hit "too many submission attempts"
     - A real volunteer accidentally tripped a limit and needs help
   Apps Script CacheService doesn't expose a list-keys API, so we
   can't enumerate every key — we clear the known keys for one
   email instead. For full reset use clearAllRateLimits().
   ============================================================ */
function clearRateLimitsForEmail() {
  // EDIT THIS to the email you want to reset, then click Run.
  const email = 'b.mallikarjun1@gmail.com';

  const cache = CacheService.getScriptCache();
  const lower = email.toLowerCase().trim();
  const keys = [
    'rl:hrs:' + lower,                              // hours-submission limit
    'rl:cert:' + lower,                             // cert-email limit
    'rl:reg:' + lower + '|',                        // registration (student email side)
    'rl:reg:|' + lower,                             // registration (parent email side)
    'rl:otp-send:' + lower,                         // OTP send limit
    'rl:otp-verify:' + lower                        // OTP verify limit
  ];
  cache.removeAll(keys);
  Logger.log('Cleared rate-limit keys for ' + email + ': ' + keys.join(', '));
  return 'Cleared rate-limit keys for ' + email;
}

/**
 * Nuclear option: wipes the entire script cache. Affects all users.
 * Safe to run (only short-lived cache data lives there: rate-limit counters,
 * OTP codes, verification tokens). After running, any in-flight OTP will need
 * to be re-sent and any verified registration session will need to re-verify.
 */
function clearAllRateLimits() {
  // CacheService doesn't have a clearAll(). We can't list keys, so the only
  // way to nuke all data is to invalidate by replacing values with TTL=1.
  // Practically: just call clearRateLimitsForEmail() for each test email you
  // use. This stub stays here so future-you knows the constraint.
  Logger.log('CacheService has no clearAll API. Edit clearRateLimitsForEmail() with each email you want to reset, or wait the 1-hour TTL.');
  return 'See log: CacheService has no clearAll API — use clearRateLimitsForEmail() instead.';
}

/* ============================================================
   PRE-EVENT EMAIL BLAST — June 4, 2026 at 6 PM EST
   --------------------------------------------------------------
   Goal: 48 hours before the event, send EVERY registered volunteer
   (and their parent) a personalized email telling them where to
   report on event day.

   Four variants based on the sheet's "Assigned Team" column:
     - "DJ Team"      → 3 volunteers, sound/music support. Arrive 4:00 PM.
                        POC: Gouri DJ · +1 773 934 2072
     - "GTA Stall"    → 4 volunteers, manning water/soft-drinks stall.
                        Arrive 4:30 PM. POCs: Abhinay, Rohith C · +1 607 761 7217
     - "Balloon Team" → 1 volunteer, helping decorate. Arrive 4:30 PM.
                        POC: Ramya · +1 216 333 8633
     - (blank/other)  → report to the volunteer registration desk
                        on arrival at 4:30 PM. Default for everyone else.

   Two functions exposed:
     1. sendPreEventEmails()   — does the actual blast (idempotent)
     2. setupPreEventTrigger() — schedules sendPreEventEmails() to fire
                                 automatically on Thu 6/4 at 6 PM EST.

   Usage workflow:
     a) Open the Google Sheet. In "Assigned Team" column, type
        "GTA Stall" for the 4 chosen volunteers and "Balloon Team"
        for the 1 chosen volunteer. Leave blank for everyone else.
     b) (Recommended) Run testPreEventEmail() once — sends a test
        copy to the admin email only so you can verify formatting.
     c) Either: run sendPreEventEmails() manually at 6 PM Thursday,
        OR run setupPreEventTrigger() once now and walk away —
        Apps Script will fire it automatically.
   ============================================================ */

// Edit these only if the contacts/teams change before the event:
const PRE_EVENT_CONFIG = {
  // When to fire the auto-trigger (Eastern Time)
  scheduledYear:  2026,
  scheduledMonth: 5,        // 0-indexed → 5 = June
  scheduledDay:   4,        // June 4 = Thursday
  scheduledHour:  18,       // 6 PM
  scheduledMinute: 0,
  scheduledTimezone: 'America/New_York',
  // Test recipient (used by testPreEventEmail() only)
  testRecipient: 'b.mallikarjun1@gmail.com',
  // Per-team POC details — appear in the corresponding email body.
  // arrivalTime is the team's specific call time on event day (6 June 2026).
  // DJ Team arrives early (4:00 PM) for sound check; all other teams arrive
  // 30 minutes before the public event open at 4:30 PM.
  teams: {
    'DJ Team': {
      label: 'DJ Team — Sound & Music',
      pocLine: 'Gouri DJ',
      pocPhone: '+1 773 934 2072',
      arrivalTime: '4:00 PM EST',
      arrivalNote: '(early call — please be on-site by 4:00 PM sharp for sound check)',
      duties: 'You will be part of the DJ Team helping with sound setup, music coordination, and live audio support throughout the event.'
    },
    'GTA Stall': {
      label: 'GTA Stall — Water & Soft Drinks',
      pocLine: 'Abhinay & Rohith C',
      pocPhone: '+1 607 761 7217',
      arrivalTime: '4:30 PM EST',
      arrivalNote: '',
      duties: 'You will be helping manage the GTA stall — serving water, soft drinks, and assisting visitors at the booth.'
    },
    'Balloon Team': {
      label: 'Balloon Team — Decorations',
      pocLine: 'Ramya',
      pocPhone: '+1 216 333 8633',
      arrivalTime: '4:30 PM EST',
      arrivalNote: '',
      duties: 'You will be part of the Balloon Team helping with decorations and balloon arrangements at the venue.'
    }
  },
  // Default for everyone else (blank Assigned Team)
  defaultTeam: {
    label: 'Registration Desk',
    pocLine: 'GTA Volunteer Registration Desk',
    pocPhone: '',
    arrivalTime: '4:30 PM EST',
    arrivalNote: '',
    duties: 'On arrival at the venue, please check in at the GTA Volunteer Registration Desk. The on-site team will assign you a role based on the day-of needs.'
  },
  // Event details — same for all variants
  event: {
    name: 'GTA International Fest 2026',
    date: 'Saturday, June 6, 2026',
    time: '3:00 PM – 9:00 PM EST',
    venue: 'Fowler Park, Cumming GA'
  }
};

/* ------------------------ THE BLAST ------------------------ */
function sendPreEventEmails() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  ensureHeaders(sheet);
  const all = sheet.getDataRange().getValues();
  if (all.length < 2) {
    Logger.log('No volunteers registered yet — nothing to send.');
    return 'No volunteers on file.';
  }

  const headers = all[0];
  const idx = (name) => headers.indexOf(name);

  const cFirst       = idx('First Name');
  const cLast        = idx('Last Name');
  const cStudentEmail = idx('Student Email');
  const cParentEmail = idx('Parent Email');
  const cParentName  = idx('Parent/Guardian Name');
  const cAssigned    = idx('Assigned Team');
  const cSentStamp   = idx('Pre-event Email Sent');
  const cIsStudent   = idx('Is Student?');

  if (cAssigned < 0 || cSentStamp < 0) {
    throw new Error('Sheet is missing "Assigned Team" and/or "Pre-event Email Sent" columns. Run ensureHeaders() or add them manually.');
  }

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 1; i < all.length; i++) {
    const r = all[i];
    const rowNum = i + 1;
    const firstName    = String(r[cFirst]       || '').trim();
    const lastName     = String(r[cLast]        || '').trim();
    const studentEmail = String(r[cStudentEmail] || '').toLowerCase().trim();
    const parentEmail  = String(r[cParentEmail]  || '').toLowerCase().trim();
    const isStudent    = String(r[cIsStudent]   || 'Yes').trim();
    const assigned     = String(r[cAssigned]    || '').trim();
    const alreadySent  = String(r[cSentStamp]   || '').trim();

    // Pick primary recipient: student-mode uses studentEmail (fallback parent),
    // adult-mode the parentEmail IS the volunteer's own email.
    const primaryEmail = studentEmail || parentEmail;
    if (!primaryEmail || primaryEmail.indexOf('@') < 0) {
      Logger.log('Row ' + rowNum + ' (' + firstName + ' ' + lastName + '): no valid email, skipping.');
      skipped++;
      continue;
    }
    if (alreadySent) {
      Logger.log('Row ' + rowNum + ' (' + firstName + ' ' + lastName + '): already sent at ' + alreadySent + ', skipping.');
      skipped++;
      continue;
    }

    // Pick the right team variant
    const team = PRE_EVENT_CONFIG.teams[assigned] || PRE_EVENT_CONFIG.defaultTeam;

    try {
      const subject = `[GTA Fest 2026] Your volunteer assignment — ${team.label} · See you Saturday!`;
      const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
      const html = buildPreEventEmailHtml(firstName, lastName, team, isStudent);
      const plain = buildPreEventEmailPlain(firstName, lastName, team, isStudent);

      const options = {
        name: 'Global Telangana Association',
        htmlBody: html
      };
      // CC parent if they entered one AND it's different from the primary
      // (in adult mode, primaryEmail === parentEmail, so no self-CC)
      if (parentEmail && parentEmail !== primaryEmail && parentEmail.indexOf('@') > -1) {
        options.cc = parentEmail;
      }

      MailApp.sendEmail(primaryEmail, subject, plain, options);
      sheet.getRange(rowNum, cSentStamp + 1).setValue(new Date().toLocaleString());
      Logger.log('Sent row ' + rowNum + ' to=' + primaryEmail + ' cc=' + (options.cc || '(none)') + ' team=' + (team.label));
      sent++;
    } catch (err) {
      Logger.log('FAILED row ' + rowNum + ' (' + firstName + ' ' + lastName + '): ' + err.toString());
      errors++;
    }
  }

  SpreadsheetApp.flush();
  const summary = `Pre-event email blast complete: sent=${sent}, skipped=${skipped}, errors=${errors}. Quota remaining: ${MailApp.getRemainingDailyQuota()}.`;
  Logger.log(summary);
  return summary;
}

function buildPreEventEmailPlain(firstName, lastName, team, isStudent) {
  const e = PRE_EVENT_CONFIG.event;
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const studentNote = (isStudent === 'No')
    ? ''
    : '\n(Parents/guardians: a copy of this email has been sent to you so you know your volunteer\'s assignment for Saturday.)\n';
  const pocBlock = team.pocPhone
    ? `On arrival at the venue, please contact:\n  ${team.pocLine}\n  Phone: ${team.pocPhone}\n`
    : `On arrival at the venue, please report to the ${team.pocLine}.\n`;
  const arrivalLine = team.arrivalNote
    ? `  ${team.arrivalTime}  ${team.arrivalNote}`
    : `  ${team.arrivalTime}`;

  return (
    greeting + '\n\n' +
    `This is a reminder that ${e.name} is THIS SATURDAY!\n\n` +
    `──────────────────────────────\n` +
    `Date:  ${e.date}\n` +
    `Event: ${e.time}\n` +
    `Venue: ${e.venue}\n` +
    `──────────────────────────────\n\n` +
    `YOUR ASSIGNMENT: ${team.label}\n\n` +
    `>>> ARRIVE BY: ${team.arrivalTime} ${team.arrivalNote || ''} <<<\n\n` +
    team.duties + '\n\n' +
    pocBlock + '\n' +
    `What to bring:\n` +
    `  • Your QR code from your original registration confirmation (the GTA admin will scan it on arrival to check you in).\n` +
    `  • Comfortable, closed-toe shoes.\n` +
    `  • A water bottle (we will refill).\n` +
    `  • A smile :)\n\n` +
    `Questions before the event? Reply to this email or contact gtaadmin2026@gmail.com.\n` +
    studentNote +
    '\nLooking forward to seeing you Saturday!\n\n' +
    'Warm regards,\n' +
    'Global Telangana Association — Atlanta\n' +
    'www.gtaatlanta.org'
  );
}

function buildPreEventEmailHtml(firstName, lastName, team, isStudent) {
  const e = PRE_EVENT_CONFIG.event;
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const pocHtml = team.pocPhone
    ? `<div style="background:#fff8ec;border-left:4px solid #d4a437;padding:12px 16px;margin:14px 0;border-radius:4px"><strong>📍 On arrival at the venue, contact:</strong><br><strong style="font-size:16px">${team.pocLine}</strong><br>📞 <a href="tel:${team.pocPhone.replace(/\s+/g,'')}" style="color:#c1272d;text-decoration:none">${team.pocPhone}</a></div>`
    : `<div style="background:#fff8ec;border-left:4px solid #d4a437;padding:12px 16px;margin:14px 0;border-radius:4px"><strong>📍 On arrival at the venue:</strong><br>Please report to the <strong>${team.pocLine}</strong>. The on-site team will assign you a role.</div>`;
  const parentLine = (isStudent === 'No')
    ? ''
    : '<p style="color:#6b7280;font-size:12px;margin-top:18px;padding-top:12px;border-top:1px solid #e5e7eb">A copy of this email has also been sent to your parent/guardian so they know your assignment for Saturday.</p>';

  return (
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;max-width:620px;color:#1f2937">` +
    `<div style="background:linear-gradient(135deg,#7a0c16,#c1272d 60%,#ff6b35);color:#fff;padding:22px;border-radius:10px 10px 0 0">` +
      `<div style="font-size:12px;letter-spacing:1.5px;opacity:0.9">GLOBAL TELANGANA ASSOCIATION · ATLANTA</div>` +
      `<div style="font-size:22px;font-weight:800;margin-top:6px">🎉 Your Volunteer Assignment</div>` +
      `<div style="font-size:14px;margin-top:4px;color:#ffd166">${e.name}</div>` +
    `</div>` +
    `<div style="background:#fff8ec;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px">` +
      `<p>${greeting}</p>` +
      `<p>This is a reminder that <strong>${e.name}</strong> is <strong>THIS SATURDAY</strong>!</p>` +
      `<table style="border-collapse:collapse;margin:16px 0;width:100%">` +
        `<tr><td style="padding:8px 14px;border:1px solid #e5e7eb;background:#f9fafb;width:30%"><strong>📅 Date</strong></td><td style="padding:8px 14px;border:1px solid #e5e7eb">${e.date}</td></tr>` +
        `<tr><td style="padding:8px 14px;border:1px solid #e5e7eb;background:#f9fafb"><strong>⏰ Time</strong></td><td style="padding:8px 14px;border:1px solid #e5e7eb">${e.time}</td></tr>` +
        `<tr><td style="padding:8px 14px;border:1px solid #e5e7eb;background:#f9fafb"><strong>📍 Venue</strong></td><td style="padding:8px 14px;border:1px solid #e5e7eb">${e.venue}</td></tr>` +
      `</table>` +
      `<div style="background:linear-gradient(135deg,#fff,#fef3c7);border:2px solid #d4a437;border-radius:8px;padding:16px;margin:16px 0">` +
        `<div style="font-size:11px;letter-spacing:1.5px;color:#92400e;font-weight:700">YOUR ASSIGNMENT</div>` +
        `<div style="font-size:20px;font-weight:800;color:#7a0c16;margin-top:4px">${team.label}</div>` +
        `<p style="margin:10px 0 0;color:#451a03">${team.duties}</p>` +
      `</div>` +
      // Arrival-time call-out — bright so it can't be missed
      `<div style="background:#7a0c16;color:#fff;border-radius:8px;padding:14px 18px;margin:16px 0;text-align:center">` +
        `<div style="font-size:11px;letter-spacing:1.5px;color:#ffd166;font-weight:700">⏰ ARRIVE BY</div>` +
        `<div style="font-size:24px;font-weight:800;margin-top:4px;letter-spacing:0.5px">${team.arrivalTime}</div>` +
        (team.arrivalNote ? `<div style="font-size:12px;color:#ffd166;margin-top:6px;font-style:italic">${team.arrivalNote}</div>` : '') +
      `</div>` +
      pocHtml +
      `<p style="margin-top:18px"><strong>What to bring:</strong></p>` +
      `<ul style="margin:6px 0 16px;padding-left:22px;color:#374151">` +
        `<li>Your <strong>QR code</strong> from your original registration email (the GTA admin will scan it on arrival to check you in)</li>` +
        `<li>Comfortable, closed-toe shoes</li>` +
        `<li>A water bottle (we'll refill)</li>` +
        `<li>A smile 🙂</li>` +
      `</ul>` +
      `<p style="color:#6b7280;font-size:13px">Questions before the event? Reply to this email or contact <a href="mailto:gtaadmin2026@gmail.com" style="color:#c1272d">gtaadmin2026@gmail.com</a>.</p>` +
      parentLine +
      `<p style="margin-top:20px">Looking forward to seeing you Saturday!<br><br>Warm regards,<br><strong>Global Telangana Association — Atlanta</strong><br>` +
      `<a href="https://www.gtaatlanta.org" style="color:#c1272d">www.gtaatlanta.org</a></p>` +
    `</div>` +
    `</div>`
  );
}

/* ---------- SAFE TEST: sends ONE email to the test recipient only ---------- */
function testPreEventEmail() {
  const team = PRE_EVENT_CONFIG.teams['GTA Stall']; // preview the stall variant
  const html = buildPreEventEmailHtml('Test', 'Volunteer', team, 'Yes');
  const plain = buildPreEventEmailPlain('Test', 'Volunteer', team, 'Yes');
  MailApp.sendEmail(PRE_EVENT_CONFIG.testRecipient,
    '[TEST] GTA pre-event email — GTA Stall variant',
    plain,
    { name: 'Global Telangana Association', htmlBody: html });
  Logger.log('Test email sent to ' + PRE_EVENT_CONFIG.testRecipient);
  return 'Sent test to ' + PRE_EVENT_CONFIG.testRecipient;
}

/* ---------- TRIGGER SETUP: schedule sendPreEventEmails for Thu 6/4 6 PM EST ---------- */
function setupPreEventTrigger() {
  // Remove any existing trigger for this function so we don't duplicate
  const existing = ScriptApp.getProjectTriggers();
  existing.forEach(function(t) {
    if (t.getHandlerFunction() === 'sendPreEventEmails') {
      ScriptApp.deleteTrigger(t);
      Logger.log('Removed existing trigger.');
    }
  });

  // Build the target time in the configured timezone
  const c = PRE_EVENT_CONFIG;
  // Apps Script time-based triggers fire in the script's timezone, so set it
  // to America/New_York at the project level for accuracy, then schedule.
  const target = new Date(c.scheduledYear, c.scheduledMonth, c.scheduledDay, c.scheduledHour, c.scheduledMinute, 0);
  const now = new Date();
  if (target.getTime() < now.getTime()) {
    throw new Error('Target time ' + target.toString() + ' is in the past. Edit PRE_EVENT_CONFIG.');
  }

  ScriptApp.newTrigger('sendPreEventEmails')
    .timeBased()
    .at(target)
    .inTimezone(c.scheduledTimezone)
    .create();
  const summary = 'Trigger scheduled for ' + target.toLocaleString() + ' (' + c.scheduledTimezone + '). It will run ONCE.';
  Logger.log(summary);
  return summary;
}

/* ---------- ADMIN HELPER: clear "Pre-event Email Sent" stamps for a re-run ---------- */
function clearPreEventSendStamps() {
  // Run this if you want to re-send to everyone (e.g. you fixed a typo in the
  // email body). It blanks out the "Pre-event Email Sent" column so the blast
  // function sees every row as un-sent again.
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const all = sheet.getDataRange().getValues();
  const headers = all[0];
  const col = headers.indexOf('Pre-event Email Sent');
  if (col < 0) return 'No "Pre-event Email Sent" column found.';
  for (let i = 1; i < all.length; i++) {
    sheet.getRange(i + 1, col + 1).setValue('');
  }
  SpreadsheetApp.flush();
  Logger.log('Cleared ' + (all.length - 1) + ' send stamps.');
  return 'Cleared all send stamps. Next sendPreEventEmails() run will email everyone again.';
}

/* ============================================================
   POST-EVENT THANK-YOU BLAST
   --------------------------------------------------------------
   Sends ONE email FROM gtaadmin2026@gmail.com TO itself, with
   every volunteer (and their parent, if different) BCC'd. The
   BCC pattern means recipients can't see each other's emails —
   important for privacy on a community-organization mailing list.

   FILTER: only volunteers whose row has BOTH "Checked In At" AND
   "Checked Out At" populated. Volunteers who registered but
   didn't actually attend the event are excluded automatically.

   To make the From: address actually be gtaadmin2026@gmail.com,
   ONE of these must be true:
     (a) The Apps Script project is owned by gtaadmin2026@gmail.com
         (best — run this script from that account), OR
     (b) gtaadmin2026@gmail.com is set up as a "send-mail-as" alias
         in the script owner's Gmail Settings → Accounts → "Send mail
         as", with verification completed.
   Otherwise MailApp falls back to the script owner's primary
   address and the from-option is silently ignored.
   ============================================================ */

const POST_EVENT_CONFIG = {
  fromEmail: 'gtaadmin2026@gmail.com',
  fromName:  'Global Telangana Association — Atlanta',
  // Test recipient (used by testPostEventThankYou)
  testRecipient: 'b.mallikarjun1@gmail.com',
  registrationUrl: 'https://gtafest.github.io/gta-volunteer-fest/',
  // How many days post-event before data deletion (used in email body)
  dataRetentionDays: 7
};

function sendPostEventThankYou() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  ensureHeaders(sheet);
  const all = sheet.getDataRange().getValues();
  if (all.length < 2) {
    Logger.log('No volunteers on file — nothing to send.');
    return 'No volunteers on file.';
  }

  const headers = all[0];
  const idx = (n) => headers.indexOf(n);
  const cFirst       = idx('First Name');
  const cLast        = idx('Last Name');
  const cStudentEmail = idx('Student Email');
  const cParentEmail = idx('Parent Email');
  const cCheckedIn   = idx('Checked In At');
  const cCheckedOut  = idx('Checked Out At');
  const cSent        = idx('Post-event Email Sent');

  if (cCheckedIn < 0 || cCheckedOut < 0) {
    throw new Error('Sheet is missing "Checked In At" / "Checked Out At" columns. Redeploy the latest backend (ensureHeaders adds them automatically on first save).');
  }
  if (cSent < 0) {
    throw new Error('Sheet is missing "Post-event Email Sent" column. Add it as the last column, or redeploy the latest backend.');
  }

  // Collect deduped recipients + matching row numbers
  const recipients = {};      // email → true (acts as a Set)
  const rowsToStamp = [];     // row numbers to mark as "sent" after success
  let scanned = 0;
  let skippedNotCheckedOut = 0;
  let skippedAlreadySent = 0;

  for (let i = 1; i < all.length; i++) {
    const r = all[i];
    scanned++;
    const checkedIn  = String(r[cCheckedIn]  || '').trim();
    const checkedOut = String(r[cCheckedOut] || '').trim();
    if (!checkedIn || !checkedOut) { skippedNotCheckedOut++; continue; }
    if (String(r[cSent] || '').trim()) { skippedAlreadySent++; continue; }

    const studentEmail = String(r[cStudentEmail] || '').toLowerCase().trim();
    const parentEmail  = String(r[cParentEmail]  || '').toLowerCase().trim();
    let added = false;
    if (studentEmail && studentEmail.indexOf('@') > -1) {
      recipients[studentEmail] = true;
      added = true;
    }
    if (parentEmail && parentEmail.indexOf('@') > -1 && parentEmail !== studentEmail) {
      recipients[parentEmail] = true;
      added = true;
    }
    if (added) rowsToStamp.push(i + 1);
  }

  const bccList = Object.keys(recipients);
  if (bccList.length === 0) {
    const msg = 'No volunteers met the criteria (checked-IN + checked-OUT + not already sent). Scanned=' + scanned + ' skippedNotCheckedOut=' + skippedNotCheckedOut + ' skippedAlreadySent=' + skippedAlreadySent;
    Logger.log(msg);
    return msg;
  }

  Logger.log('Post-event thank-you: scanned=' + scanned + ' eligible=' + rowsToStamp.length + ' uniqueEmails=' + bccList.length);

  // Gmail BCC has a soft limit — chunk at 90 to be safe (limit is 100 but
  // some headers count, and a few addresses may be invalid).
  const CHUNK = 90;
  const chunks = [];
  for (let k = 0; k < bccList.length; k += CHUNK) chunks.push(bccList.slice(k, k + CHUNK));

  const subject = '🙏 Thank You, Volunteers & Families — From the Entire GTA Family';
  const plainBody = buildPostEventPlain();
  const htmlBody  = buildPostEventHtml();

  // Resolve sending strategy ONCE (not per-chunk) — log identity for audit trail
  let effectiveUser = '(unknown)';
  let aliases = [];
  try { effectiveUser = Session.getEffectiveUser().getEmail(); } catch (e) {}
  try { aliases = GmailApp.getAliases(); } catch (e) {}
  let useAlias = false;
  if (effectiveUser.toLowerCase() === POST_EVENT_CONFIG.fromEmail.toLowerCase()) {
    Logger.log('IDENTITY: script owner IS ' + POST_EVENT_CONFIG.fromEmail + ' — From: will be set automatically by MailApp. No alias needed.');
  } else if (aliases.indexOf(POST_EVENT_CONFIG.fromEmail) > -1) {
    useAlias = true;
    Logger.log('IDENTITY: using verified alias ' + POST_EVENT_CONFIG.fromEmail + ' on owner ' + effectiveUser);
  } else {
    Logger.log('⚠️ IDENTITY WARNING: script owner is ' + effectiveUser + ' and ' + POST_EVENT_CONFIG.fromEmail + ' is NOT an alias. The blast will go FROM ' + effectiveUser + ' (NOT from gtaadmin2026). If this is wrong, abort with Ctrl+C or close the tab.');
  }

  let sentBatches = 0;
  let totalSent   = 0;
  chunks.forEach(function(chunk, idx) {
    try {
      const options = {
        name: POST_EVENT_CONFIG.fromName,
        htmlBody: htmlBody,
        bcc: chunk.join(',')
      };
      if (useAlias) options.from = POST_EVENT_CONFIG.fromEmail;
      // Send TO the fromEmail itself, BCC everyone
      MailApp.sendEmail(POST_EVENT_CONFIG.fromEmail, subject, plainBody, options);
      sentBatches++;
      totalSent += chunk.length;
      Logger.log('Batch ' + (idx + 1) + '/' + chunks.length + ': BCC count=' + chunk.length);
    } catch (err) {
      Logger.log('Batch ' + (idx + 1) + ' FAILED: ' + err.toString());
    }
  });

  // Stamp each eligible row only if at least one batch went out successfully
  if (sentBatches > 0) {
    const ts = new Date().toLocaleString();
    rowsToStamp.forEach(function(rowNum) {
      sheet.getRange(rowNum, cSent + 1).setValue(ts);
    });
    SpreadsheetApp.flush();
  }

  const summary = 'Post-event thank-you complete: batches=' + sentBatches + '/' + chunks.length + ' uniqueRecipients=' + totalSent + ' rowsStamped=' + (sentBatches > 0 ? rowsToStamp.length : 0) + ' quotaRemaining=' + MailApp.getRemainingDailyQuota();
  Logger.log(summary);
  return summary;
}

function buildPostEventPlain() {
  const reg = POST_EVENT_CONFIG.registrationUrl;
  const d   = POST_EVENT_CONFIG.dataRetentionDays;
  return (
    'Dear Volunteers and Parents,\n\n' +
    '────────────────────────────────────\n' +
    'You are the foundation of GTA International Fest 2026.\n' +
    '────────────────────────────────────\n\n' +
    'On behalf of the entire Global Telangana Association family, THANK YOU. ' +
    'Our volunteers — every single one of you — are the heart of this event. The festival came to life because each of you chose to give your time, your energy, ' +
    'and your spirit of seva to your community. Without you, none of it happens.\n\n' +
    'To our parents and guardians: an equally heartfelt thank-you. Your incredible support, your encouragement, and the values you instill in these young hearts ' +
    'are what gave our volunteers the courage and confidence to step up and serve. Every kid who showed up on Saturday did so because someone at home believed in them. ' +
    'Thank you for being that someone.\n\n' +
    '────────────────────────────────────\n' +
    'YOUR DIGITAL VOLUNTEER CERTIFICATE\n' +
    '────────────────────────────────────\n' +
    'Many of you have already downloaded your personalized GTA Volunteer Certificate. If you have not yet:\n\n' +
    '  1. Open ' + reg + '\n' +
    '  2. Click the "⏱️ Volunteered Hours" tab\n' +
    '  3. Enter the same email and last name you used to register\n' +
    '  4. Enter your hours and click submit\n' +
    '\n' +
    'Your certificate will be downloaded automatically AND a copy emailed to you (and your parent, if you provided a parent email). ' +
    'If anything on the certificate needs adjustment — a misspelling, a different name format, anything at all — just reply to this email at ' +
    'gtaadmin2026@gmail.com and we will be happy to accommodate any changes you need.\n\n' +
    '────────────────────────────────────\n' +
    'IMPORTANT — DATA RETENTION\n' +
    '────────────────────────────────────\n' +
    'To protect your privacy, the registration data we hold (names, contact info, hours) will be automatically deleted from our system in approximately ' +
    d + ' days from today. Please download your certificate before then. Even after the data is deleted, you can still reach us at gtaadmin2026@gmail.com ' +
    'with any questions, requests, or future volunteering interest — we are always here.\n\n' +
    '────────────────────────────────────\n' +
    'LOOKING FORWARD\n' +
    '────────────────────────────────────\n' +
    'Thank you, once again, from the entire GTA family. As we move forward, we are incredibly excited to call on amazing volunteers like you for the events ' +
    'and community-service initiatives we will be organizing in the coming months. Your spirit of seva is what keeps our community strong and our culture alive. ' +
    'We cannot wait to serve alongside you again soon.\n\n' +
    'With deep gratitude,\n' +
    'Global Telangana Association — Atlanta\n' +
    'gtaadmin2026@gmail.com\n' +
    'www.gtaatlanta.org'
  );
}

function buildPostEventHtml() {
  const reg = POST_EVENT_CONFIG.registrationUrl;
  const d   = POST_EVENT_CONFIG.dataRetentionDays;
  return (
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;max-width:640px;color:#1f2937;line-height:1.6">` +
      // Header
      `<div style="background:linear-gradient(135deg,#7a0c16,#c1272d 60%,#ff6b35);color:#fff;padding:28px 24px;border-radius:10px 10px 0 0;text-align:center">` +
        `<div style="font-size:12px;letter-spacing:2px;opacity:0.85">GLOBAL TELANGANA ASSOCIATION · ATLANTA</div>` +
        `<div style="font-size:28px;font-weight:800;margin-top:8px">🙏 Thank You</div>` +
        `<div style="font-size:14px;margin-top:6px;color:#ffd166">From the Entire GTA Family</div>` +
      `</div>` +
      // Body
      `<div style="background:#fff8ec;padding:28px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px">` +
        `<p style="margin:0 0 14px">Dear Volunteers and Parents,</p>` +
        // Section 1 — Foundation thanks
        `<div style="background:#fff;border-left:4px solid #d4a437;padding:14px 18px;margin:18px 0;border-radius:4px">` +
          `<div style="font-size:11px;letter-spacing:1.5px;color:#92400e;font-weight:700">YOU ARE THE FOUNDATION</div>` +
          `<p style="margin:8px 0 0">On behalf of the entire <strong>Global Telangana Association family</strong>, THANK YOU. Our volunteers — every single one of you — are the heart of this event. The festival came to life because each of you chose to give your time, your energy, and your spirit of <em>seva</em> to your community. Without you, none of it happens.</p>` +
          `<p style="margin:12px 0 0">To our <strong>parents and guardians</strong>: an equally heartfelt thank-you. Your incredible support, encouragement, and the values you instill in these young hearts are what gave our volunteers the courage and confidence to step up and serve. Every kid who showed up on Saturday did so because someone at home believed in them. Thank you for being that someone.</p>` +
        `</div>` +
        // Section 2 — Certificate instructions
        `<div style="background:#fff;border:1px solid #e5e7eb;padding:14px 18px;margin:18px 0;border-radius:6px">` +
          `<div style="font-size:14px;font-weight:800;color:#7a0c16;margin-bottom:6px">📜 Your Digital Volunteer Certificate</div>` +
          `<p style="margin:0 0 10px">Many of you have already downloaded your personalized GTA Volunteer Certificate. If you haven't yet, it takes about 30 seconds:</p>` +
          `<ol style="margin:0 0 10px;padding-left:22px">` +
            `<li>Open <a href="${reg}" style="color:#c1272d;font-weight:600">${reg}</a></li>` +
            `<li>Click the <strong>"⏱️ Volunteered Hours"</strong> tab</li>` +
            `<li>Enter the same email and last name you used to register</li>` +
            `<li>Enter your hours and submit</li>` +
          `</ol>` +
          `<p style="margin:0">Your certificate will be downloaded automatically AND a copy emailed to you (with your parent CC'd if you provided a parent email). <strong>Need a change?</strong> If anything on the certificate needs adjustment — a misspelling, a different name format, anything at all — just reply to this email at <a href="mailto:gtaadmin2026@gmail.com" style="color:#c1272d">gtaadmin2026@gmail.com</a> and we'll be happy to accommodate.</p>` +
        `</div>` +
        // Section 3 — Data retention notice
        `<div style="background:#fef3c7;border-left:4px solid #d97706;padding:12px 16px;margin:18px 0;border-radius:4px">` +
          `<div style="font-size:11px;letter-spacing:1.5px;color:#92400e;font-weight:700">⚠️ IMPORTANT — DATA RETENTION</div>` +
          `<p style="margin:8px 0 0;color:#78350f">To protect your privacy, the registration data we hold (names, contact info, hours) will be <strong>automatically deleted from our system in approximately ${d} days</strong> from today. Please download your certificate before then. Even after the data is deleted, you can still reach us at <a href="mailto:gtaadmin2026@gmail.com" style="color:#7a0c16;font-weight:600">gtaadmin2026@gmail.com</a> with any questions or future volunteering interest — we're always here.</p>` +
        `</div>` +
        // Section 4 — Looking forward
        `<div style="background:#fff;border-left:4px solid #c1272d;padding:14px 18px;margin:18px 0;border-radius:4px">` +
          `<div style="font-size:11px;letter-spacing:1.5px;color:#7a0c16;font-weight:700">LOOKING FORWARD</div>` +
          `<p style="margin:8px 0 0">Thank you, once again, from the entire GTA family. As we move forward, we are incredibly excited to call on amazing volunteers like you for the events and community-service initiatives we'll be organizing <strong>in the coming months</strong>. Your spirit of seva is what keeps our community strong and our culture alive. We cannot wait to serve alongside you again soon.</p>` +
        `</div>` +
        // Sign-off
        `<p style="margin:24px 0 0">With deep gratitude,<br><strong>Global Telangana Association — Atlanta</strong><br>` +
        `<a href="mailto:gtaadmin2026@gmail.com" style="color:#c1272d">gtaadmin2026@gmail.com</a><br>` +
        `<a href="https://www.gtaatlanta.org" style="color:#c1272d">www.gtaatlanta.org</a></p>` +
      `</div>` +
    `</div>`
  );
}

/* ---------- SAFE TEST: sends one preview to the test recipient only ---------- */
function testPostEventThankYou() {
  // ===== Diagnostic block: tell us WHO is actually running this script =====
  let activeUser  = '(unknown)';
  let effectiveUser = '(unknown)';
  let aliases = [];
  try { activeUser    = Session.getActiveUser().getEmail();    } catch (e) { Logger.log('activeUser error: '    + e); }
  try { effectiveUser = Session.getEffectiveUser().getEmail(); } catch (e) { Logger.log('effectiveUser error: ' + e); }
  try { aliases       = GmailApp.getAliases();                 } catch (e) { Logger.log('aliases error: '       + e); }
  Logger.log('==================== IDENTITY CHECK ====================');
  Logger.log('Active user (logged-in user):    ' + activeUser);
  Logger.log('Effective user (script owner):   ' + effectiveUser);
  Logger.log('Aliases on the EFFECTIVE user:   ' + JSON.stringify(aliases));
  Logger.log('Target From: address:            ' + POST_EVENT_CONFIG.fromEmail);
  Logger.log('========================================================');

  // Decide how to send:
  //   (1) If the effective user IS already gtaadmin2026, no alias needed —
  //       MailApp sends from the script owner automatically.
  //   (2) Else if gtaadmin2026 is set up as an alias on the owner, use it.
  //   (3) Else log a clear WARNING and send from whatever the owner address is.
  const options = {
    name: POST_EVENT_CONFIG.fromName,
    htmlBody: buildPostEventHtml()
  };

  let strategy;
  if (effectiveUser.toLowerCase() === POST_EVENT_CONFIG.fromEmail.toLowerCase()) {
    strategy = '✅ STRATEGY 1: script owner IS ' + POST_EVENT_CONFIG.fromEmail + ' — no alias needed. Email will be sent FROM gtaadmin2026.';
  } else if (aliases.indexOf(POST_EVENT_CONFIG.fromEmail) > -1) {
    options.from = POST_EVENT_CONFIG.fromEmail;
    strategy = '✅ STRATEGY 2: using verified alias ' + POST_EVENT_CONFIG.fromEmail + ' on owner ' + effectiveUser;
  } else {
    strategy = '⚠️ STRATEGY 3 (FALLBACK): owner is ' + effectiveUser + ' and ' + POST_EVENT_CONFIG.fromEmail + ' is NOT in their aliases. Email will go FROM ' + effectiveUser + '. To fix: either transfer Apps Script ownership to ' + POST_EVENT_CONFIG.fromEmail + ' AND run the script as that account, or set up ' + POST_EVENT_CONFIG.fromEmail + ' as a "Send mail as" alias on ' + effectiveUser;
  }
  Logger.log(strategy);

  MailApp.sendEmail(POST_EVENT_CONFIG.testRecipient,
    '[TEST] Post-event thank-you preview',
    buildPostEventPlain(),
    options);
  Logger.log('Test post-event email sent to ' + POST_EVENT_CONFIG.testRecipient);
  Logger.log('Open the test email and click the sender to see the actual From: address Gmail recorded.');
  return strategy;
}

/* ---------- ADMIN HELPER: clear post-event stamps for a re-run ---------- */
function clearPostEventSendStamps() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const all = sheet.getDataRange().getValues();
  const col = all[0].indexOf('Post-event Email Sent');
  if (col < 0) return 'No "Post-event Email Sent" column found.';
  for (let i = 1; i < all.length; i++) sheet.getRange(i + 1, col + 1).setValue('');
  SpreadsheetApp.flush();
  return 'Cleared all post-event send stamps. Next sendPostEventThankYou() run will re-include those rows.';
}

/* ============================================================
   PII RETENTION WIPE — June 14, 2026 at 2:00 AM ET
   --------------------------------------------------------------
   GDPR / COPPA-friendly anonymization. After 7 days, every PII
   field is wiped or anonymized so the sheet preserves AGGREGATE
   reporting value (school participation counts, hours totals,
   role distribution) without retaining any way to identify
   individual volunteers.

   FIELDS WIPED (set to blank or generic value):
     - Date of Birth, Student ID
     - Student Email, Student Phone
     - Parent/Guardian Name, Parent Email, Parent Phone, Relationship
     - Emergency Contact Name, Emergency Contact Phone
     - Allergies, Medical Conditions, Medications
     - Volunteer Notes (may contain personal anecdotes)
     - Check-in Token, Deletion Token (no longer needed once anonymized)
     - Checked In By, Checked Out By (admin names, conservative wipe)

   FIELDS ANONYMIZED (replaced with initials):
     - First Name → first initial + "."     (e.g. "Priya" → "P.")
     - Last Name  → first initial + "."     (e.g. "Reddy" → "R.")
     - Submission ID → kept as-is (already an opaque ID, no PII)

   FIELDS KEPT (aggregate value, not PII):
     - Submitted At, Activity Date
     - School Name, Grade Level
     - Volunteer Role, Organization, Hours Pledged
     - Supervisor Name/Contact, Description
     - Actual Hours Completed, Hours Submitted At, Hours Receipt ID
     - Is Student?, Adult/Parent Consent flags
     - Checked In At, Checked Out At, Verified Duration, Hours Status
     - Assigned Team, all email-sent timestamps

   IDEMPOTENT: each row gets stamped with "PII Wiped At" timestamp;
   subsequent runs skip already-wiped rows.
   ============================================================ */

const PII_WIPE_CONFIG = {
  // Scheduled run time — June 14, 2026 at 2:00 AM Eastern Time.
  scheduledYear: 2026,
  scheduledMonth: 5,         // 0-indexed → 5 = June
  scheduledDay: 14,
  scheduledHour: 2,
  scheduledMinute: 0,
  scheduledTimezone: 'America/New_York'
};

function wipePiiForRetention() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  ensureHeaders(sheet);
  const all = sheet.getDataRange().getValues();
  if (all.length < 2) {
    Logger.log('No rows to wipe.');
    return 'No rows on file.';
  }

  const headers = all[0];
  const idx = (n) => headers.indexOf(n);

  // Columns to BLANK
  const blankCols = [
    'Date of Birth', 'Student ID',
    'Student Email', 'Student Phone',
    'Parent/Guardian Name', 'Parent Email', 'Parent Phone', 'Relationship',
    'Emergency Contact Name', 'Emergency Contact Phone',
    'Allergies', 'Medical Conditions', 'Medications',
    'Volunteer Notes',
    'Check-in Token', 'Deletion Token',
    'Checked In By', 'Checked Out By'
  ].map(idx).filter(i => i >= 0);

  // Columns to ANONYMIZE (transform fn)
  const initial = (s) => {
    const t = String(s || '').trim();
    return t ? (t.charAt(0).toUpperCase() + '.') : '';
  };
  const anonCols = [
    { col: idx('First Name'), fn: initial },
    { col: idx('Last Name'),  fn: initial }
  ].filter(o => o.col >= 0);

  const cWiped = idx('PII Wiped At');
  if (cWiped < 0) {
    throw new Error('Sheet is missing "PII Wiped At" column. Save the latest backend so ensureHeaders adds it.');
  }

  let wiped = 0;
  let skipped = 0;
  const ts = new Date().toLocaleString();

  for (let i = 1; i < all.length; i++) {
    const r = all[i];
    const rowNum = i + 1;
    if (String(r[cWiped] || '').trim()) {
      skipped++;
      continue;   // already wiped on a prior run
    }

    // Blank out the PII columns
    blankCols.forEach(function(c) {
      sheet.getRange(rowNum, c + 1).setValue('');
    });
    // Anonymize the name columns
    anonCols.forEach(function(o) {
      sheet.getRange(rowNum, o.col + 1).setValue(o.fn(r[o.col]));
    });
    // Stamp the wipe timestamp
    sheet.getRange(rowNum, cWiped + 1).setValue(ts);
    // Visual cue: tint the row light gray to flag "anonymized"
    sheet.getRange(rowNum, 1, 1, headers.length).setBackground('#f3f4f6');
    wiped++;
  }
  SpreadsheetApp.flush();

  const summary = `PII retention wipe complete: wiped=${wiped} skippedAlreadyWiped=${skipped} at ${ts}`;
  Logger.log(summary);
  return summary;
}

/* ---------- TRIGGER SETUP ---------- */
function setupPiiWipeTrigger() {
  const c = PII_WIPE_CONFIG;
  // Remove any existing trigger for this handler to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'wipePiiForRetention') {
      ScriptApp.deleteTrigger(t);
      Logger.log('Removed existing PII-wipe trigger.');
    }
  });

  const target = new Date(c.scheduledYear, c.scheduledMonth, c.scheduledDay, c.scheduledHour, c.scheduledMinute, 0);
  if (target.getTime() < new Date().getTime()) {
    throw new Error('Target time ' + target.toString() + ' is in the past. Edit PII_WIPE_CONFIG.');
  }
  ScriptApp.newTrigger('wipePiiForRetention')
    .timeBased()
    .at(target)
    .inTimezone(c.scheduledTimezone)
    .create();
  const summary = 'PII wipe scheduled for ' + target.toLocaleString() + ' (' + c.scheduledTimezone + '). Runs ONCE.';
  Logger.log(summary);
  return summary;
}

/* ---------- DRY-RUN PREVIEW (no changes written) ---------- */
function previewPiiWipe() {
  // Logs what WOULD be wiped without actually modifying the sheet.
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  ensureHeaders(sheet);
  const all = sheet.getDataRange().getValues();
  const headers = all[0];
  const idx = (n) => headers.indexOf(n);
  const cWiped = idx('PII Wiped At');
  let eligible = 0, alreadyWiped = 0;
  for (let i = 1; i < all.length; i++) {
    if (String(all[i][cWiped] || '').trim()) alreadyWiped++;
    else eligible++;
  }
  const summary = 'DRY RUN: rows that WOULD be wiped on next run: ' + eligible + '. Already-wiped (will be skipped): ' + alreadyWiped + '. No changes were made.';
  Logger.log(summary);
  return summary;
}

/* ============================================================
   GROQ PROXY — keeps the API key on the server, never in the browser
   --------------------------------------------------------------
   Client sends { action: 'proxyGroq', sessionId, messages, ... }.
   This forwards to Groq using GTA_CONFIG.groqApiKey and returns
   the assistant's reply. Rate-limited per session.
   ============================================================ */
function handleProxyGroq(data) {
  // Rate limit by session — 30 requests/minute, 200/hour per session
  const session = data.sessionId || 'anonymous';
  if (!checkRateLimit('groq-min:' + session, 30, 60)) {
    return jsonResponse({ status: 'error', message: 'Too many AI requests. Please wait a minute and try again.' });
  }
  if (!checkRateLimit('groq-hour:' + session, 200, 3600)) {
    return jsonResponse({ status: 'error', message: 'AI usage limit reached for this session. Try again later.' });
  }

  if (!hasGroqKeyServer()) {
    return jsonResponse({ status: 'error', message: 'Server-side AI is not configured. Ask the GTA admin to set GTA_CONFIG.groqApiKey.' });
  }

  // Validate inputs
  if (!data.messages || !Array.isArray(data.messages) || data.messages.length === 0) {
    return jsonResponse({ status: 'error', message: 'Invalid request: messages array required.' });
  }
  if (data.messages.length > 25) {
    return jsonResponse({ status: 'error', message: 'Too many messages in conversation.' });
  }

  // Constrain max_tokens to avoid runaway cost
  const maxTokens = Math.min(parseInt(data.maxTokens || 250, 10), 500);
  const temperature = Math.min(Math.max(parseFloat(data.temperature || 0.5), 0), 1.5);

  try {
    const response = UrlFetchApp.fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'post',
      headers: {
        'Authorization': 'Bearer ' + GTA_CONFIG.groqApiKey,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: data.messages,
        temperature: temperature,
        max_tokens: maxTokens
      }),
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
      Logger.log('Proxy Groq non-200: ' + response.getResponseCode());
      return jsonResponse({ status: 'error', message: 'AI service unavailable. Please try again.' });
    }
    const result = JSON.parse(response.getContentText());
    const reply = (result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content || '').trim();
    return jsonResponse({ status: 'ok', reply: reply, model: 'llama-3.1-8b-instant' });
  } catch (err) {
    Logger.log('Proxy Groq failed: ' + err.toString());
    return jsonResponse({ status: 'error', message: 'AI service error.' });
  }
}

/* ============================================================
   EMAIL VERIFICATION (OTP) — gates the registration form
   --------------------------------------------------------------
   Two-step flow:
     1) Client posts {action: 'sendOtp', email}
        → server stores 6-digit code in CacheService (10 min TTL)
        → server sends code to that email via MailApp
     2) Client posts {action: 'verifyOtp', email, code}
        → server checks code, issues a verifiedToken (6 h validity)
        → client passes that token with the registration submission
   handleRegistration verifies the token before accepting the row.
   ============================================================ */
function handleSendOtp(data) {
  const email = (data.email || '').toLowerCase().trim();
  if (!isValidEmailFormat(email)) {
    return jsonResponse({ status: 'error', message: 'Please enter a valid email address.' });
  }
  // Reject school email addresses — they block our confirmation mail
  if (isSchoolEmail(email)) {
    return jsonResponse({ status: 'error', message: SCHOOL_EMAIL_REJECT_MESSAGE, code: 'school_email' });
  }
  // Rate limit: 3 codes per email per hour
  if (!checkRateLimit('otp-send:' + email, 3, 3600)) {
    return jsonResponse({ status: 'error', message: 'Too many code requests for this email. Try again in an hour.' });
  }

  // Generate a 6-digit code (zero-padded)
  const code = String(Math.floor(100000 + Math.random() * 900000));
  CacheService.getScriptCache().put('otp:' + email, code, 600); // 10 min TTL

  // Skip replyTo if it still contains an obvious placeholder ('example.', 'YOUR_', etc.)
  // — invalid replyTo addresses are a strong spam-filter signal.
  const reply = (GTA_CONFIG.contactEmail || '').toString();
  const replyToVal = (reply && !/example\.|YOUR_|change.?me/i.test(reply)) ? reply : '';

  Logger.log('OTP send: to=' + email + ' replyTo=' + (replyToVal || '(none)') + ' quotaRemaining=' + MailApp.getRemainingDailyQuota());

  try {
    MailApp.sendEmail(email, 'Your GTA Volunteer verification code: ' + code, buildOtpPlain(code), {
      name: GTA_CONFIG.senderName || 'GTA Volunteer',
      replyTo: replyToVal,
      htmlBody: buildOtpHtml(code)
    });
    Logger.log('OTP send OK for ' + email);
    return jsonResponse({ status: 'ok', message: 'Code sent. Check your inbox (and spam folder).' });
  } catch (err) {
    Logger.log('OTP send FAILED: ' + err.toString());
    return jsonResponse({ status: 'error', message: 'Could not send the code right now: ' + err.toString().substring(0, 120) });
  }
}

function handleVerifyOtp(data) {
  const email = (data.email || '').toLowerCase().trim();
  const code = (data.code || '').trim();

  if (!checkRateLimit('otp-verify:' + email, 8, 3600)) {
    return jsonResponse({ status: 'error', message: 'Too many verification attempts. Try again later.' });
  }
  if (!/^\d{6}$/.test(code)) {
    return jsonResponse({ status: 'error', message: 'Code must be 6 digits.' });
  }

  const cache = CacheService.getScriptCache();
  const stored = cache.get('otp:' + email);
  if (!stored) {
    return jsonResponse({ status: 'error', message: 'Code expired or not found. Please request a new code.' });
  }
  if (stored !== code) {
    return jsonResponse({ status: 'error', message: 'Incorrect code. Please try again.' });
  }

  // Code matched — issue a verification token (6 h validity)
  cache.remove('otp:' + email);
  const token = 'VER-' + Utilities.getUuid().replace(/-/g, '').substring(0, 24);
  cache.put('vtoken:' + token, email, 21600); // 6 h

  return jsonResponse({ status: 'ok', verifiedToken: token, email: email });
}

function isValidEmailFormat(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
}

/* ============================================================
   SCHOOL EMAIL DETECTOR
   --------------------------------------------------------------
   Many school districts (Forsyth, Gwinnett, Cobb, Fulton, etc.)
   filter or block automated mail from outside their domain. Our
   OTP and confirmation emails get bounced. So we refuse school
   addresses up front and ask the parent for a personal email
   (Gmail, Yahoo, iCloud, Outlook personal, etc.) which actually
   receives our messages reliably.
   ============================================================ */
function isSchoolEmail(s) {
  const e = String(s || '').toLowerCase().trim();
  if (!e) return false;
  // Common school email patterns worldwide
  const schoolPatterns = [
    /\.edu$/,                     // US universities + many K-12
    /\.edu\./,                    // .edu.in, .edu.au, .edu.sg, etc.
    /\.k12\./,                    // US K-12 districts (.k12.ga.us, .k12.fl.us, ...)
    /\.ac\.[a-z]{2,3}$/,          // Academic (.ac.uk, .ac.in)
    /\.sch\.[a-z]{2,3}$/,         // School (.sch.uk)
    /onmicrosoft\.com$/,          // School Microsoft tenants (often blocked — your Forsyth case)
    /\bforsyth/i,                 // Forsyth County Schools (the user's bounced case)
    /\bgwinnett/i,                // Gwinnett County Schools
    /\bcobb\b.*\b(k12|school|edu)/i,
    /\bfulton\b.*\b(k12|school|edu)/i,
    /\bfcps/i,                    // Fairfax/Fulton County Public Schools
    /studentmail\./i              // common student-mail subdomains
  ];
  return schoolPatterns.some(function(p) { return p.test(e); });
}

const SCHOOL_EMAIL_REJECT_MESSAGE =
  'School email addresses (e.g., .edu, .k12, onmicrosoft.com, district domains) often block our confirmation emails. Please use a personal email instead — Gmail, Yahoo, iCloud, or Outlook personal all work great.';

function buildOtpHtml(code) {
  return '<div style="font-family: Arial, Helvetica, sans-serif; max-width: 460px; margin: 0 auto; background: #ffffff;">' +
    '<div style="background: linear-gradient(135deg, #c1272d, #ff6b35); color: white; padding: 24px; text-align: center;">' +
      '<h2 style="margin: 0; font-size: 18px; font-weight: 700;">Global Telangana Association</h2>' +
      '<p style="margin: 4px 0 0; font-size: 13px; opacity: 0.95;">GTA International Fest — Volunteer Verification</p>' +
    '</div>' +
    '<div style="padding: 24px; color: #1f2937;">' +
      '<p style="margin: 0 0 12px; line-height: 1.5;">Hi,</p>' +
      '<p style="margin: 0 0 16px; line-height: 1.5;">A volunteer registration was started for your child using this email. Use this code to confirm:</p>' +
      '<div style="text-align: center; padding: 22px; background: #fff8ec; border: 2px solid #d4a437; border-radius: 8px; margin: 16px 0;">' +
        '<div style="font-size: 38px; font-weight: 700; letter-spacing: 8px; color: #c1272d; font-family: \'Courier New\', monospace;">' + code + '</div>' +
      '</div>' +
      '<p style="margin: 16px 0 0; font-size: 13px; color: #6b7280; line-height: 1.5;">This code expires in <strong>10 minutes</strong>. If you did not request this, you can safely ignore this email — no action needed.</p>' +
    '</div>' +
    '<div style="padding: 14px 24px; background: #f5f7fb; text-align: center; font-size: 11px; color: #6b7280;">' +
      'Global Telangana Association · Automated verification' +
    '</div>' +
  '</div>';
}

function buildOtpPlain(code) {
  return [
    'GTA International Fest — Volunteer Verification',
    '',
    'A volunteer registration was started for your child using this email.',
    '',
    'Your code: ' + code,
    '',
    'This code expires in 10 minutes. If you did not request this, ignore this email.',
    '',
    '— Global Telangana Association'
  ].join('\n');
}

/* ============================================================
   SELF-SERVICE DELETION
   --------------------------------------------------------------
   Each registration gets a unique deletion token. The confirmation
   email includes a link with that token. Clicking the link routes
   to doGet → handleDeleteConfirm, which shows a "are you sure?"
   page. Submitting deletes the row.
   ============================================================ */
function generateDeletionToken() {
  return 'DEL-' + Utilities.getUuid().replace(/-/g, '').substring(0, 16).toUpperCase();
}

/* ============================================================
   EVENT-DAY CHECK-IN
   --------------------------------------------------------------
   Each registration gets a unique check-in token. A QR encoding
   that token is embedded in the confirmation email. On event day,
   the GTA admin opens checkin.html (PIN-protected), scans the
   volunteer's QR with their phone camera, and confirms check-in.
   ============================================================ */
function generateCheckInToken() {
  return 'CHK-' + Utilities.getUuid().replace(/-/g, '').substring(0, 14).toUpperCase();
}

function buildCheckInQrUrl(token) {
  // What the QR ENCODES — preferably a full URL so phone cameras open it directly.
  // Falls back to just the token if appBaseUrl isn't configured yet.
  let payload;
  let baseUrl = String(GTA_CONFIG.appBaseUrl || '').trim();
  if (baseUrl && baseUrl.indexOf('YOUR-USERNAME') === -1 && baseUrl.indexOf('YOUR-REPO') === -1) {
    if (baseUrl.charAt(baseUrl.length - 1) !== '/') baseUrl += '/';
    payload = baseUrl + 'checkin.html?token=' + encodeURIComponent(token);
  } else {
    payload = token;
  }
  // Free, no-key QR generator service
  return 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&format=png&margin=10&data=' + encodeURIComponent(payload);
}

function handleLookupVolunteer(data) {
  if (!data.adminPin || data.adminPin !== ADMIN_PIN) {
    return jsonResponse({ status: 'error', message: 'Invalid admin PIN.' });
  }
  const token = String(data.token || '').trim();
  if (!token) {
    return jsonResponse({ status: 'error', message: 'Missing check-in token.' });
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  ensureHeaders(sheet);
  const all = sheet.getDataRange().getValues();
  if (all.length < 2) {
    return jsonResponse({ status: 'error', message: 'No registrations on file yet.' });
  }
  const headers = all[0];
  const tokenCol = headers.indexOf('Check-in Token');
  if (tokenCol < 0) {
    return jsonResponse({ status: 'error', message: 'Sheet missing "Check-in Token" column. Redeploy the latest backend.' });
  }

  let matchIdx = -1;
  for (let i = 1; i < all.length; i++) {
    if (String(all[i][tokenCol] || '') === token) { matchIdx = i; break; }
  }
  if (matchIdx === -1) {
    return jsonResponse({ status: 'error', message: 'No registration found for this QR code. Either the QR is invalid, or the registration was deleted.' });
  }

  const r = all[matchIdx];
  const get = (name) => {
    const i = headers.indexOf(name);
    return i >= 0 ? String(r[i] || '') : '';
  };

  return jsonResponse({
    status: 'ok',
    volunteer: {
      rowNumber: matchIdx + 1,
      firstName:    get('First Name'),
      lastName:     get('Last Name'),
      isStudent:    get('Is Student?'),
      gradeLevel:   get('Grade Level'),
      schoolName:   get('School Name'),
      role:         get('Volunteer Role'),
      hoursPledged: get('Hours Pledged'),
      parentName:   get('Parent/Guardian Name'),
      parentEmail:  get('Parent Email'),
      parentPhone:  get('Parent Phone'),
      emergencyName: get('Emergency Contact Name'),
      emergencyPhone: get('Emergency Contact Phone'),
      allergies:    get('Allergies'),
      medicalConditions: get('Medical Conditions'),
      medications:  get('Medications'),
      submittedAt:  get('Submitted At'),
      submissionId: get('Submission ID'),
      checkedInAt:  get('Checked In At'),
      checkedInBy:  get('Checked In By'),
      checkedOutAt: get('Checked Out At'),
      checkedOutBy: get('Checked Out By'),
      verifiedDuration: get('Verified Duration (hrs)'),
      hoursStatus:  get('Hours Status')
    }
  });
}

function handleConfirmCheckIn(data) {
  if (!data.adminPin || data.adminPin !== ADMIN_PIN) {
    return jsonResponse({ status: 'error', message: 'Invalid admin PIN.' });
  }
  const token = String(data.token || '').trim();
  if (!token) {
    return jsonResponse({ status: 'error', message: 'Missing check-in token.' });
  }
  // mode: 'in' (default) for arrival; 'out' for departure
  const mode = (String(data.mode || 'in').toLowerCase() === 'out') ? 'out' : 'in';

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  ensureHeaders(sheet);
  const all = sheet.getDataRange().getValues();
  const headers = all[0];
  const tokenCol = headers.indexOf('Check-in Token');
  const checkedInAtCol = headers.indexOf('Checked In At');
  const checkedInByCol = headers.indexOf('Checked In By');
  const checkedOutAtCol = headers.indexOf('Checked Out At');
  const checkedOutByCol = headers.indexOf('Checked Out By');
  const verifiedDurCol = headers.indexOf('Verified Duration (hrs)');
  const hoursStatusCol = headers.indexOf('Hours Status');
  const firstNameCol = headers.indexOf('First Name');
  const lastNameCol  = headers.indexOf('Last Name');

  if (tokenCol < 0 || checkedInAtCol < 0) {
    return jsonResponse({ status: 'error', message: 'Sheet missing check-in columns. Redeploy the latest backend.' });
  }
  if (mode === 'out' && (checkedOutAtCol < 0 || verifiedDurCol < 0)) {
    return jsonResponse({ status: 'error', message: 'Sheet missing check-out columns. Redeploy the latest backend so the new columns are added.' });
  }

  let matchIdx = -1;
  for (let i = 1; i < all.length; i++) {
    if (String(all[i][tokenCol] || '') === token) { matchIdx = i; break; }
  }
  if (matchIdx === -1) {
    return jsonResponse({ status: 'error', message: 'No registration found for this QR code.' });
  }

  const rowNum = matchIdx + 1;
  const existingCheckIn  = String(all[matchIdx][checkedInAtCol] || '').trim();
  const existingCheckOut = checkedOutAtCol >= 0 ? String(all[matchIdx][checkedOutAtCol] || '').trim() : '';
  const adminName = String(data.adminName || 'GTA Admin').trim().substring(0, 60);
  const now = new Date();
  const ts  = now.toLocaleString();

  /* ---------- CHECK-IN PATH ---------- */
  if (mode === 'in') {
    const alreadyCheckedIn = !!existingCheckIn;
    if (!alreadyCheckedIn) {
      sheet.getRange(rowNum, checkedInAtCol + 1).setValue(ts);
      sheet.getRange(rowNum, checkedInByCol + 1).setValue(adminName);
      sheet.getRange(rowNum, 1, 1, headers.length).setBackground('#e0f2fe'); // light blue = checked in
      SpreadsheetApp.flush();
    }
    return jsonResponse({
      status: 'ok',
      mode: 'in',
      alreadyCheckedIn: alreadyCheckedIn,
      checkedInAt: alreadyCheckedIn ? existingCheckIn : ts,
      checkedInBy: alreadyCheckedIn ? String(all[matchIdx][checkedInByCol] || '') : adminName,
      checkedOutAt: existingCheckOut,
      firstName: String(all[matchIdx][firstNameCol] || ''),
      lastName:  String(all[matchIdx][lastNameCol]  || '')
    });
  }

  /* ---------- CHECK-OUT PATH ---------- */
  // Guard: can't check out if never checked in
  if (!existingCheckIn) {
    return jsonResponse({
      status: 'error',
      message: 'This volunteer was never checked IN. Please scan their QR for check-IN first before checking them out.'
    });
  }

  // Guard: idempotent — if already checked out, return existing values (don't overwrite)
  if (existingCheckOut) {
    const existingDur = verifiedDurCol >= 0 ? String(all[matchIdx][verifiedDurCol] || '') : '';
    return jsonResponse({
      status: 'ok',
      mode: 'out',
      alreadyCheckedOut: true,
      checkedInAt:  existingCheckIn,
      checkedInBy:  String(all[matchIdx][checkedInByCol] || ''),
      checkedOutAt: existingCheckOut,
      checkedOutBy: String(all[matchIdx][checkedOutByCol] || ''),
      verifiedDuration: existingDur,
      firstName: String(all[matchIdx][firstNameCol] || ''),
      lastName:  String(all[matchIdx][lastNameCol]  || '')
    });
  }

  // Compute verified duration in hours (rounded to nearest 0.25h)
  const inTime = new Date(existingCheckIn);
  let verifiedHrs = 0;
  if (!isNaN(inTime.getTime())) {
    const diffMs = now.getTime() - inTime.getTime();
    verifiedHrs = Math.round((diffMs / (1000 * 60 * 60)) * 4) / 4; // nearest 0.25
    if (verifiedHrs < 0) verifiedHrs = 0;
  }

  sheet.getRange(rowNum, checkedOutAtCol + 1).setValue(ts);
  sheet.getRange(rowNum, checkedOutByCol + 1).setValue(adminName);
  sheet.getRange(rowNum, verifiedDurCol + 1).setValue(verifiedHrs);
  if (hoursStatusCol >= 0) {
    sheet.getRange(rowNum, hoursStatusCol + 1).setValue('Awaiting hours submission');
  }
  // Highlight row green-ish to flag checked-out (will be overwritten by hours submission later)
  sheet.getRange(rowNum, 1, 1, headers.length).setBackground('#bbf7d0');
  SpreadsheetApp.flush();

  return jsonResponse({
    status: 'ok',
    mode: 'out',
    alreadyCheckedOut: false,
    checkedInAt:  existingCheckIn,
    checkedInBy:  String(all[matchIdx][checkedInByCol] || ''),
    checkedOutAt: ts,
    checkedOutBy: adminName,
    verifiedDuration: verifiedHrs,
    firstName: String(all[matchIdx][firstNameCol] || ''),
    lastName:  String(all[matchIdx][lastNameCol]  || '')
  });
}

/* ============================================================
   EMAIL CERTIFICATE — receives a base64 PDF from the client
   ============================================================
   After the volunteer submits their hours (and they pass the
   verification gate), the client renders the personalized GTA
   certificate and POSTs it here as base64. We look up the row
   to grab the parent email, then send the certificate to the
   volunteer with the parent CC'd.

   We deliberately keep this lightweight + idempotent: the
   volunteer already has a downloaded copy; if the email fails
   they're not blocked. Errors are logged for the admin to
   investigate.
   ============================================================ */
function handleEmailCertificate(data) {
  const email = String(data.email || '').toLowerCase().trim();
  const last  = String(data.lastName || '').toLowerCase().trim();
  if (!email || !last) {
    return jsonResponse({ status: 'error', message: 'Missing email or last name.' });
  }
  // 10 cert-email sends per volunteer per hour (was 3 — too tight for testing/retries)
  if (!checkRateLimit('cert:' + email, 10, 3600)) {
    return jsonResponse({ status: 'error', message: 'Certificate email rate-limited. Wait a few minutes and try again.' });
  }

  // Look up the matching row to grab the parent email + name + role fields
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  ensureHeaders(sheet);
  const all = sheet.getDataRange().getValues();
  if (all.length < 2) return jsonResponse({ status: 'error', message: 'No registrations on file.' });

  const headers = all[0];
  const cEmail  = headers.indexOf('Student Email');
  const cLast   = headers.indexOf('Last Name');
  const cFirst  = headers.indexOf('First Name');
  const cParent = headers.indexOf('Parent Email');
  const cHours  = headers.indexOf('Actual Hours Completed');
  const cRole   = headers.indexOf('Volunteer Role');
  const cSchool = headers.indexOf('School Name');

  // Adult volunteers register with their email in the Parent Email column
  // (no student email), so we match on EITHER column.
  let matchIdx = -1;
  for (let i = all.length - 1; i >= 1; i--) {
    const rowStudentEmail = cEmail  >= 0 ? String(all[i][cEmail]  || '').toLowerCase().trim() : '';
    const rowParentEmail  = cParent >= 0 ? String(all[i][cParent] || '').toLowerCase().trim() : '';
    const rowLast = String(all[i][cLast] || '').toLowerCase().trim();
    if (rowLast === last && (rowStudentEmail === email || rowParentEmail === email)) { matchIdx = i; break; }
  }
  if (matchIdx === -1) {
    return jsonResponse({ status: 'error', message: 'No matching registration found.' });
  }

  const firstName  = String(all[matchIdx][cFirst] || '');
  const lastName   = String(all[matchIdx][cLast]  || '');
  const parentEmail = cParent >= 0 ? String(all[matchIdx][cParent] || '').toLowerCase().trim() : '';
  const hours      = String(all[matchIdx][cHours] || '');
  const role       = cRole   >= 0 ? String(all[matchIdx][cRole]   || '') : '';
  const school     = cSchool >= 0 ? String(all[matchIdx][cSchool] || '') : '';

  // Decode the base64 PDF into a Blob attachment (optional — if missing, we
  // still send a confirmation email, just without the cert attached)
  let pdfBlob = null;
  if (data.pdfBase64) {
    try {
      const bytes = Utilities.base64Decode(data.pdfBase64);
      pdfBlob = Utilities.newBlob(bytes, 'application/pdf', data.pdfFilename || 'GTA_Volunteer_Certificate.pdf');
    } catch (e) {
      Logger.log('Cert PDF decode failed (sending email without attachment): ' + e.toString());
    }
  }

  // Compose the consolidated confirmation email — thank-you + appreciation +
  // verification details + (optional) PDF certificate
  const appreciation = String(data.appreciation || '').trim();
  const subject = `✓ Hours confirmed — ${hours} hrs · GTA International Fest · ${firstName} ${lastName}`;
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';

  const plainBody =
    `${greeting}\n\n` +
    `Thank you for volunteering at the GTA International Fest! Your hours have been verified and locked into our records.\n\n` +
    `${appreciation ? appreciation + '\n\n' : ''}` +
    `─────────────────────────────\n` +
    `Hours verified:   ${hours}\n` +
    (role   ? `Volunteer role:   ${role}\n`   : '') +
    (school ? `School:           ${school}\n` : '') +
    `Receipt ID:       ${data.receiptId || '—'}\n` +
    `─────────────────────────────\n\n` +
    (pdfBlob ? `Your personalized GTA volunteer certificate is attached to this email. ` : `(Your certificate PDF will arrive separately.) `) +
    `Please show it to your school counselor or community-service coordinator. ` +
    `If anyone needs to verify the hours, they can contact the Global Telangana Association volunteer coordinator.\n\n` +
    (parentEmail && parentEmail !== email ? `A copy of this email has been sent to your parent/guardian (${parentEmail}).\n\n` : '') +
    `Warm regards,\n` +
    `Global Telangana Association — Atlanta\n` +
    `www.gtaatlanta.org`;

  const htmlBody =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;max-width:600px;color:#1f2937">` +
    `<div style="background:linear-gradient(135deg,#7a0c16,#c1272d);color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">` +
      `<div style="font-size:13px;letter-spacing:1px;opacity:0.85">GLOBAL TELANGANA ASSOCIATION · ATLANTA</div>` +
      `<div style="font-size:20px;font-weight:800;margin-top:4px">✓ Volunteer Hours Confirmed</div>` +
    `</div>` +
    `<div style="background:#fff8ec;padding:22px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px">` +
      `<p>${greeting}</p>` +
      `<p>Thank you for volunteering at the <strong>GTA International Fest</strong>! Your hours have been verified and locked into our records.</p>` +
      (appreciation ? `<div style="background:#fffbeb;border-left:4px solid #d4a437;padding:12px 16px;margin:14px 0;font-style:italic;color:#78350f">${appreciation}</div>` : '') +
      `<table style="border-collapse:collapse;margin:14px 0;width:100%">` +
        `<tr><td style="padding:8px 14px;border:1px solid #e5e7eb;background:#f9fafb;width:40%"><strong>Hours verified</strong></td><td style="padding:8px 14px;border:1px solid #e5e7eb"><strong style="color:#059669;font-size:18px">${hours}</strong></td></tr>` +
        (role   ? `<tr><td style="padding:8px 14px;border:1px solid #e5e7eb;background:#f9fafb"><strong>Volunteer role</strong></td><td style="padding:8px 14px;border:1px solid #e5e7eb">${role}</td></tr>` : '') +
        (school ? `<tr><td style="padding:8px 14px;border:1px solid #e5e7eb;background:#f9fafb"><strong>School</strong></td><td style="padding:8px 14px;border:1px solid #e5e7eb">${school}</td></tr>` : '') +
        `<tr><td style="padding:8px 14px;border:1px solid #e5e7eb;background:#f9fafb"><strong>Receipt ID</strong></td><td style="padding:8px 14px;border:1px solid #e5e7eb;font-family:monospace;font-size:12px">${data.receiptId || '—'}</td></tr>` +
      `</table>` +
      (pdfBlob
        ? `<div style="background:#d1fae5;border-left:4px solid #059669;padding:12px 16px;margin:14px 0;border-radius:4px"><strong>📎 Your personalized GTA volunteer certificate is attached.</strong> Please show it to your school counselor or community-service coordinator.</div>`
        : `<div style="background:#fef3c7;border-left:4px solid #d97706;padding:12px 16px;margin:14px 0;border-radius:4px">Your certificate PDF will arrive separately.</div>`
      ) +
      `<p style="color:#6b7280;font-size:13px">If anyone needs to verify the hours, they can contact the Global Telangana Association volunteer coordinator.</p>` +
      (parentEmail && parentEmail !== email
        ? `<p style="color:#6b7280;font-size:12px;margin-top:18px;padding-top:12px;border-top:1px solid #e5e7eb">A copy of this email has been sent to your parent/guardian at <strong>${parentEmail}</strong>.</p>`
        : '') +
      `<p style="margin-top:20px">Warm regards,<br><strong>Global Telangana Association — Atlanta</strong><br>` +
      `<a href="https://www.gtaatlanta.org" style="color:#c1272d">www.gtaatlanta.org</a></p>` +
    `</div>` +
    `</div>`;

  const options = {
    name: 'Global Telangana Association',
    htmlBody: htmlBody
  };
  if (pdfBlob) options.attachments = [pdfBlob];
  // CC the parent if a parent email was entered AND it's different from the
  // primary recipient (in adult mode the "parent email" IS the volunteer's
  // own email, so we don't want to CC them to themselves).
  if (parentEmail && parentEmail !== email && parentEmail.indexOf('@') > -1) {
    options.cc = parentEmail;
  }

  try {
    MailApp.sendEmail(email, subject, plainBody, options);
    Logger.log('Confirmation email sent: to=' + email + ' cc=' + (options.cc || '(none)') + ' attachment=' + (pdfBlob ? 'yes' : 'no') + ' quotaRemaining=' + MailApp.getRemainingDailyQuota());
    return jsonResponse({ status: 'ok', sentTo: email, cc: options.cc || '', attachmentSent: !!pdfBlob });
  } catch (e) {
    Logger.log('Confirmation email failed: ' + e.toString());
    return jsonResponse({ status: 'error', message: 'Email send failed: ' + e.toString() });
  }
}

function buildDeletionUrl(token) {
  // ScriptApp.getService().getUrl() returns the deployed web-app URL
  try {
    return ScriptApp.getService().getUrl() + '?action=deleteRequest&token=' + encodeURIComponent(token);
  } catch (e) {
    return '';
  }
}

function handleDeleteRequest(token) {
  if (!token) {
    return htmlResponse('<h2>Missing token</h2><p>This link looks incomplete. Please use the link from your confirmation email.</p>', 'Deletion Request — GTA');
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const all = sheet.getDataRange().getValues();
  if (all.length < 2) {
    return htmlResponse('<h2>Record not found</h2><p>This deletion link is no longer valid (the record may already be removed).</p>', 'Deletion Request — GTA');
  }
  const headers = all[0];
  const tokenCol = headers.indexOf('Deletion Token');
  const firstNameCol = headers.indexOf('First Name');
  const lastNameCol  = headers.indexOf('Last Name');
  const emailCol     = headers.indexOf('Student Email');

  let matchIdx = -1;
  for (let i = 1; i < all.length; i++) {
    if (String(all[i][tokenCol] || '') === token) { matchIdx = i; break; }
  }
  if (matchIdx === -1) {
    return htmlResponse('<h2>Record not found</h2><p>This deletion link is no longer valid (the record may already be removed). If this is a mistake, please contact the GTA team.</p>', 'Deletion Request — GTA');
  }

  const fullName = (all[matchIdx][firstNameCol] || '') + ' ' + (all[matchIdx][lastNameCol] || '');
  const email = all[matchIdx][emailCol] || '';

  // Show confirmation page with a confirm button (which POSTs to delete)
  const confirmUrl = ScriptApp.getService().getUrl() + '?action=deleteConfirm&token=' + encodeURIComponent(token);
  const html = `
    <div style="font-family: system-ui, Arial, sans-serif; max-width: 480px; margin: 40px auto; padding: 24px; background: white; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.1);">
      <h2 style="color: #c1272d; margin-top: 0;">Delete your GTA volunteer registration?</h2>
      <p style="color: #1f2937; line-height: 1.6;">We found a registration matching this token:</p>
      <div style="background: #f5f7fb; padding: 12px 16px; border-radius: 8px; margin: 12px 0;">
        <strong>${escapeHtmlEmail(fullName.trim())}</strong><br>
        <span style="color: #6b7280; font-size: 14px;">${escapeHtmlEmail(email)}</span>
      </div>
      <p style="color: #1f2937; line-height: 1.6;">If you click the button below, this record will be <strong>permanently removed</strong> from GTA's volunteer sheet. This cannot be undone.</p>
      <div style="margin-top: 24px;">
        <a href="${confirmUrl}" style="display: inline-block; padding: 12px 20px; background: #c1272d; color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">Yes, delete my registration</a>
        <a href="${ScriptApp.getService().getUrl()}" style="display: inline-block; padding: 12px 20px; color: #6b7280; text-decoration: none; margin-left: 8px;">Cancel</a>
      </div>
      <p style="margin-top: 24px; font-size: 12px; color: #9ca3af;">Contact: ${escapeHtmlEmail(GTA_CONFIG.contactEmail)}</p>
    </div>
  `;
  return htmlResponse(html, 'Confirm deletion — GTA');
}

function handleDeleteConfirm(token) {
  if (!token) {
    return htmlResponse('<h2>Missing token</h2><p>This link looks incomplete.</p>', 'Deletion — GTA');
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const all = sheet.getDataRange().getValues();
  const headers = all[0];
  const tokenCol = headers.indexOf('Deletion Token');
  let matchIdx = -1;
  for (let i = 1; i < all.length; i++) {
    if (String(all[i][tokenCol] || '') === token) { matchIdx = i; break; }
  }
  if (matchIdx === -1) {
    return htmlResponse('<h2>Already removed</h2><p>This record is no longer in our system. Nothing more to do.</p>', 'Deletion — GTA');
  }
  sheet.deleteRow(matchIdx + 1);
  return htmlResponse(`
    <div style="font-family: system-ui, Arial, sans-serif; max-width: 480px; margin: 40px auto; padding: 24px; background: white; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.1); text-align: center;">
      <div style="width: 64px; height: 64px; margin: 0 auto 16px; background: #198754; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-size: 32px;">✓</div>
      <h2 style="color: #198754; margin: 0 0 8px;">Registration deleted</h2>
      <p style="color: #1f2937; line-height: 1.6;">Your GTA volunteer registration has been permanently removed. Thank you for letting us know.</p>
      <p style="margin-top: 24px; font-size: 12px; color: #9ca3af;">Questions? Email ${escapeHtmlEmail(GTA_CONFIG.contactEmail)}</p>
    </div>
  `, 'Deletion confirmed — GTA');
}

function htmlResponse(body, title) {
  const t = title || 'GTA Volunteer App';
  return HtmlService.createHtmlOutput(`
    <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t}</title>
    <style>body{margin:0;padding:0;background:#fff8ec;font-family:system-ui,Arial,sans-serif;}</style>
    </head><body>${body}</body></html>
  `).setTitle(t);
}

// doGet handles delete-link clicks AND a default health-check page.
function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.action === 'deleteRequest') return handleDeleteRequest(params.token);
  if (params.action === 'deleteConfirm') return handleDeleteConfirm(params.token);
  return ContentService
    .createTextOutput('GTA Volunteer Backend is running. POST registrations, hours, AI proxy, or admin stats here.')
    .setMimeType(ContentService.MimeType.TEXT);
}

/* ============================================================
   EMAIL — confirmation messages
   --------------------------------------------------------------
   Uses MailApp.sendEmail (built into Apps Script).
   Daily quota: 100 emails/day on free Gmail; 1500/day on Workspace.
   The first time these run, Google will ask the GTA admin to
   authorize "Send email as you" — click through to allow.
   ============================================================ */

function sendRegistrationEmail(data) {
  if (!GTA_CONFIG.sendConfirmationEmails) return;
  if (!data) {
    Logger.log('sendRegistrationEmail called with no data — skipping.');
    return;
  }

  // Pick the best recipient:
  //   - Student mode: studentEmail (CC parentEmail)
  //   - Adult mode:   parentEmail (which is the adult's own verified email; no CC)
  const studentEmail = String(data.studentEmail || '').toLowerCase().trim();
  const parentEmail  = String(data.parentEmail  || '').toLowerCase().trim();
  const primaryEmail = studentEmail || parentEmail;

  if (!primaryEmail || !primaryEmail.includes('@')) {
    Logger.log('sendRegistrationEmail: no valid recipient — skipping. studentEmail=' + studentEmail + ' parentEmail=' + parentEmail);
    return;
  }

  // Generate the personalized AI welcome (best-effort; falls back to empty if Groq unavailable)
  data._aiWelcome = generateWelcomeMessage(data);

  const subject = 'Welcome! Your GTA International Fest volunteer registration is confirmed';
  const html = buildRegistrationHtml(data);
  const plain = buildRegistrationPlain(data);

  // Defensive replyTo — skip placeholders that trigger spam filters
  const reply = String(GTA_CONFIG.contactEmail || '');
  const replyToVal = (reply && !/example\.|YOUR_|change.?me/i.test(reply)) ? reply : '';

  const options = {
    htmlBody: html,
    name: GTA_CONFIG.senderName || 'GTA Volunteer',
    replyTo: replyToVal
  };
  // CC the parent email if it's different from the primary
  if (parentEmail && parentEmail !== primaryEmail && parentEmail.includes('@')) {
    options.cc = parentEmail;
  }

  Logger.log('sendRegistrationEmail: to=' + primaryEmail + ' cc=' + (options.cc || '(none)') + ' replyTo=' + (replyToVal || '(none)') + ' quotaRemaining=' + MailApp.getRemainingDailyQuota());

  try {
    MailApp.sendEmail(primaryEmail, subject, plain, options);
    Logger.log('Registration email sent OK to ' + primaryEmail);
  } catch (err) {
    Logger.log('Registration email FAILED: ' + err.toString());
    throw err;
  }
}

function sendHoursConfirmationEmail(data) {
  if (!GTA_CONFIG.sendConfirmationEmails) return;
  if (!data) {
    Logger.log('sendHoursConfirmationEmail called with no data — skipping.');
    return;
  }

  // Same fallback as registration: studentEmail first, then parentEmail (adult mode)
  const studentEmail = String(data.studentEmail || '').toLowerCase().trim();
  const parentEmail  = String(data.parentEmail  || '').toLowerCase().trim();
  const primaryEmail = studentEmail || parentEmail;

  if (!primaryEmail || !primaryEmail.includes('@')) {
    Logger.log('sendHoursConfirmationEmail: no valid recipient — skipping.');
    return;
  }

  // Generate the personalized appreciation (also passed back to client for the certificate PDF)
  if (!data._aiAppreciation) {
    data._aiAppreciation = generateAppreciation(data);
  }

  const subject = 'Thank you ' + (data.firstName || '') + '! Your ' + data.hoursCompleted + ' volunteer hours have been recorded';
  const html = buildHoursHtml(data);
  const plain = buildHoursPlain(data);

  // Defensive replyTo
  const reply = String(GTA_CONFIG.contactEmail || '');
  const replyToVal = (reply && !/example\.|YOUR_|change.?me/i.test(reply)) ? reply : '';

  const options = {
    htmlBody: html,
    name: GTA_CONFIG.senderName || 'GTA Volunteer',
    replyTo: replyToVal
  };
  if (parentEmail && parentEmail !== primaryEmail && parentEmail.includes('@')) {
    options.cc = parentEmail;
  }

  Logger.log('sendHoursConfirmationEmail: to=' + primaryEmail + ' cc=' + (options.cc || '(none)') + ' quotaRemaining=' + MailApp.getRemainingDailyQuota());

  try {
    MailApp.sendEmail(primaryEmail, subject, plain, options);
    Logger.log('Hours confirmation email sent OK to ' + primaryEmail);
  } catch (err) {
    Logger.log('Hours confirmation email FAILED: ' + err.toString());
    throw err;
  }
}

/* ----------------------- Email templates ----------------------- */
function buildRegistrationHtml(d) {
  const fullName = `${d.firstName || ''} ${d.lastName || ''}`.trim();
  const websiteLink = GTA_CONFIG.eventWebsiteUrl
    ? `<p style="margin: 16px 0 0;"><a href="${GTA_CONFIG.eventWebsiteUrl}" style="color:#0d6efd;">More about the event →</a></p>`
    : '';
  return `
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
  <div style="background: linear-gradient(135deg, #0d6efd, #0a58ca); color: white; padding: 28px 24px; text-align: center;">
    <h1 style="margin: 0; font-size: 22px; font-weight: 700;">Global Telangana Association</h1>
    <p style="margin: 6px 0 0; opacity: 0.9; font-size: 15px;">GTA International Fest — Volunteer Registration</p>
  </div>

  <div style="padding: 28px 24px; color: #1f2937; line-height: 1.6;">
    <h2 style="margin: 0 0 12px; font-size: 20px; color: #198754;">You're registered! 🎉</h2>
    <p style="margin: 0 0 12px;">Hi ${escapeHtmlEmail(d.firstName) || 'there'},</p>
    ${d._aiWelcome ? `
    <div style="background: linear-gradient(135deg, #fff8ec, #fdf6e3); border-left: 4px solid #d4a437; padding: 14px 18px; border-radius: 6px; margin: 0 0 18px; font-size: 15px; line-height: 1.6;">
      ${escapeHtmlEmail(d._aiWelcome).split('\n').map(p => p.trim()).filter(Boolean).join('<br><br>')}
      <div style="margin-top: 10px; font-size: 11px; color: #92741b; font-style: italic;">
        ✨ A personalized welcome generated just for you by AI based on your registration.
      </div>
    </div>
    ` : `
    <p style="margin: 0 0 20px;">Thank you for signing up to volunteer at the <strong>GTA International Fest</strong>! We're excited to have you on the team. Your registration has been received and recorded by the GTA volunteer coordinator.</p>
    `}

    <div style="background: #f5f7fb; padding: 16px 20px; border-radius: 10px; border-left: 4px solid #0d6efd; margin: 20px 0;">
      <strong style="color: #0a58ca;">Your registration details</strong>
      <table style="width: 100%; margin-top: 10px; font-size: 14px; border-collapse: collapse;">
        <tr><td style="padding: 4px 0; color: #6b7280; width: 140px;">Volunteer:</td><td style="padding: 4px 0;"><strong>${escapeHtmlEmail(fullName)}</strong></td></tr>
        <tr><td style="padding: 4px 0; color: #6b7280;">School / Grade:</td><td style="padding: 4px 0;">${escapeHtmlEmail(d.schoolName)} · ${escapeHtmlEmail(d.gradeLevel)}</td></tr>
        <tr><td style="padding: 4px 0; color: #6b7280;">Volunteer role:</td><td style="padding: 4px 0;">${escapeHtmlEmail(d.activityName)}</td></tr>
        <tr><td style="padding: 4px 0; color: #6b7280;">Hours pledged:</td><td style="padding: 4px 0;">${escapeHtmlEmail(d.hours)}</td></tr>
        <tr><td style="padding: 4px 0; color: #6b7280;">Event date:</td><td style="padding: 4px 0;">${escapeHtmlEmail(GTA_CONFIG.eventDate)}</td></tr>
        <tr><td style="padding: 4px 0; color: #6b7280;">Submission ID:</td><td style="padding: 4px 0; font-family: monospace; font-size: 12px;">${escapeHtmlEmail(d.submissionId)}</td></tr>
      </table>
    </div>

    ${d._checkInQrUrl ? `
    <!-- ============ EVENT-DAY CHECK-IN QR CODE ============ -->
    <div style="margin: 24px 0; padding: 20px; background: #ffffff; border: 2px dashed #c1272d; border-radius: 10px; text-align: center;">
      <h3 style="margin: 0 0 8px; font-size: 16px; color: #c1272d;">📱 Your Event-Day Check-in QR Code</h3>
      <p style="margin: 0 0 12px; font-size: 13px; color: #6b7280; line-height: 1.5;">Show this QR code at the GTA registration desk on event day. An admin will scan it and check you in.</p>
      <img src="${d._checkInQrUrl}" alt="Check-in QR code" width="200" height="200" style="display: block; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 6px;" />
      <p style="margin: 12px 0 0; font-family: monospace; font-size: 11px; color: #9ca3af; word-break: break-all;">${escapeHtmlEmail(d._checkInToken)}</p>
      <p style="margin: 6px 0 0; font-size: 11px; color: #9ca3af;">If the QR doesn't scan, the admin can type this token manually.</p>
    </div>
    ` : ''}

    <h3 style="margin: 24px 0 8px; font-size: 16px; color: #0a58ca;">What happens next?</h3>
    <ol style="margin: 0 0 20px; padding-left: 20px;">
      <li style="margin-bottom: 8px;">The GTA volunteer coordinator will email you with the <strong>exact event date, venue, and your assigned shift</strong>.</li>
      <li style="margin-bottom: 8px;">Show up on event day — bring water, wear comfortable clothes, and be ready to have fun.</li>
      <li style="margin-bottom: 8px;"><strong>After volunteering, come back to the form</strong> and tap the <em>"⏱️ Submit Hours"</em> tab to log your actual hours. You'll get an official receipt to use for school community-service credit.</li>
    </ol>

    <p style="margin: 24px 0 8px;">Questions? Just reply to this email or reach out at <a href="mailto:${escapeHtmlEmail(GTA_CONFIG.contactEmail)}" style="color: #0d6efd;">${escapeHtmlEmail(GTA_CONFIG.contactEmail)}</a>.</p>
    ${websiteLink}
    <p style="margin: 24px 0 0;">Thanks for being part of our community,<br><strong>The GTA Volunteer Team</strong></p>
  </div>

  <div style="padding: 16px 24px; background: #f5f7fb; text-align: center; font-size: 11px; color: #6b7280;">
    Global Telangana Association · This is an automated confirmation. ${d.parentEmail ? "A copy was also sent to your parent's email." : ''}
    ${d._deletionUrl ? `
    <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #e5e7eb; line-height: 1.6;">
      Need to update or remove your registration? <a href="${d._deletionUrl}" style="color: #c1272d;">Delete my registration</a><br>
      <span style="font-size: 10px;">(This link is unique to your registration — anyone with the link can delete this record. Keep it private.)</span>
    </div>` : ''}
  </div>
</div>`;
}

function buildRegistrationPlain(d) {
  const fullName = `${d.firstName || ''} ${d.lastName || ''}`.trim();
  const aiBlock = d._aiWelcome ? [d._aiWelcome, '', '(✨ Personalized message above generated by AI based on your registration.)', ''] : [];
  return [
    `Hi ${d.firstName || 'there'},`,
    '',
    `You're registered to volunteer at the GTA International Fest! 🎉`,
    '',
    ...aiBlock,
    `YOUR REGISTRATION DETAILS`,
    `------------------------------`,
    `Volunteer: ${fullName}`,
    `School / Grade: ${d.schoolName || ''} · ${d.gradeLevel || ''}`,
    `Volunteer role: ${d.activityName || ''}`,
    `Hours pledged: ${d.hours || ''}`,
    `Event date: ${GTA_CONFIG.eventDate}`,
    `Submission ID: ${d.submissionId || ''}`,
    '',
    d._checkInToken ? `EVENT-DAY CHECK-IN\nYour QR check-in code is included in the HTML version of this email.\nIf needed, your check-in token (admin can type it manually): ${d._checkInToken}\n` : '',
    `WHAT HAPPENS NEXT?`,
    `1) The GTA volunteer coordinator will email you the exact event date, venue, and assigned shift.`,
    `2) Show up on event day — bring water, wear comfortable clothes, be ready to help.`,
    `3) After volunteering, return to the form and tap "Submit Hours" to log your actual hours and get an official receipt for community-service credit.`,
    '',
    `Questions? Reply to this email or contact ${GTA_CONFIG.contactEmail}.`,
    GTA_CONFIG.eventWebsiteUrl ? `\nMore about the event: ${GTA_CONFIG.eventWebsiteUrl}` : '',
    '',
    `Thanks for being part of our community,`,
    `The GTA Volunteer Team`,
    '',
    `--`,
    `Global Telangana Association · Automated confirmation`,
    d._deletionUrl ? `\nNeed to update or remove your registration? Click here to delete: ${d._deletionUrl}\n(This link is unique to your registration — keep it private.)` : ''
  ].join('\n');
}

function buildHoursHtml(d) {
  const fullName = `${d.firstName || ''} ${d.lastName || ''}`.trim();
  return `
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
  <div style="background: linear-gradient(135deg, #0d6efd, #0a58ca); color: white; padding: 28px 24px; text-align: center;">
    <h1 style="margin: 0; font-size: 22px; font-weight: 700;">Global Telangana Association</h1>
    <p style="margin: 6px 0 0; opacity: 0.9; font-size: 15px;">Volunteer Hours Confirmed</p>
  </div>

  <div style="padding: 28px 24px; color: #1f2937; line-height: 1.6;">
    <h2 style="margin: 0 0 12px; font-size: 20px; color: #198754;">Thank you, ${escapeHtmlEmail(d.firstName) || 'volunteer'}! 🙏</h2>
    ${d._aiAppreciation ? `
    <div style="background: linear-gradient(135deg, #fff8ec, #fdf6e3); border-left: 4px solid #d4a437; padding: 14px 18px; border-radius: 6px; margin: 0 0 18px; font-size: 15px; line-height: 1.6; font-style: italic;">
      ${escapeHtmlEmail(d._aiAppreciation).split('\n').map(p => p.trim()).filter(Boolean).join('<br><br>')}
      <div style="margin-top: 10px; font-size: 11px; color: #92741b; font-style: normal;">
        ✨ Personalized appreciation written for you by AI based on your service.
      </div>
    </div>
    ` : `
    <p style="margin: 0 0 20px;">Your volunteer hours from the <strong>GTA International Fest</strong> have been recorded. We so appreciate the time you gave to make the event a success.</p>
    `}

    <div style="text-align: center; padding: 28px 16px; background: linear-gradient(135deg, #d1fae5, #a7f3d0); border-radius: 12px; margin: 24px 0;">
      <div style="font-size: 13px; color: #065f46; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">Hours volunteered</div>
      <div style="font-size: 56px; font-weight: 700; color: #198754; line-height: 1.1; margin: 8px 0;">${escapeHtmlEmail(d.hoursCompleted)}</div>
      <div style="font-size: 13px; color: #065f46;">in service to the GTA International Fest</div>
    </div>

    <div style="background: #f5f7fb; padding: 16px 20px; border-radius: 10px; margin: 20px 0; font-size: 14px;">
      <strong>Your record</strong><br>
      Volunteer: ${escapeHtmlEmail(fullName)}<br>
      School: ${escapeHtmlEmail(d.school)}<br>
      Role: ${escapeHtmlEmail(d.role)}<br>
      ${d.dateVolunteered ? `Date(s): ${escapeHtmlEmail(d.dateVolunteered)}<br>` : ''}
      Receipt ID: <span style="font-family: monospace; font-size: 12px;">${escapeHtmlEmail(d.receiptId)}</span>
    </div>

    <h3 style="margin: 24px 0 8px; font-size: 16px; color: #0a58ca;">Using these hours for community-service credit</h3>
    <p style="margin: 0 0 20px;">A polished PDF receipt was downloaded to your device when you submitted hours — keep it for your school. If your school needs verification, they can email <a href="mailto:${escapeHtmlEmail(GTA_CONFIG.contactEmail)}" style="color: #0d6efd;">${escapeHtmlEmail(GTA_CONFIG.contactEmail)}</a> with the receipt ID above.</p>

    <p style="margin: 24px 0 0;">From all of us at GTA — thank you for showing up for the community.<br><strong>The GTA Volunteer Team</strong></p>
  </div>

  <div style="padding: 16px 24px; background: #f5f7fb; text-align: center; font-size: 11px; color: #6b7280;">
    Global Telangana Association · This confirms your volunteer hours are on file with GTA.
  </div>
</div>`;
}

function buildHoursPlain(d) {
  const fullName = `${d.firstName || ''} ${d.lastName || ''}`.trim();
  const aiBlock = d._aiAppreciation ? [d._aiAppreciation, '', '(✨ Personalized message above generated by AI based on your service.)', ''] : [];
  return [
    `Hi ${d.firstName || 'there'},`,
    '',
    `Thank you for volunteering at the GTA International Fest! 🙏`,
    '',
    ...aiBlock,
    `Your volunteer hours have been recorded:`,
    ``,
    `   >>>  ${d.hoursCompleted} hours  <<<`,
    '',
    `Volunteer: ${fullName}`,
    `School: ${d.school || ''}`,
    `Role: ${d.role || ''}`,
    d.dateVolunteered ? `Date(s): ${d.dateVolunteered}` : '',
    `Receipt ID: ${d.receiptId || ''}`,
    '',
    `A PDF receipt was downloaded to your device when you submitted — keep it for your school's community-service credit. If your school needs verification, they can contact ${GTA_CONFIG.contactEmail} with the receipt ID above.`,
    '',
    `From all of us at GTA — thank you for showing up for the community.`,
    `The GTA Volunteer Team`,
    '',
    `--`,
    `Global Telangana Association · Automated confirmation`
  ].join('\n');
}

function escapeHtmlEmail(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ============================================================
   AI PERSONALIZATION (optional — uses Groq free tier)
   ============================================================ */
function hasGroqKeyServer() {
  return GTA_CONFIG.groqApiKey
      && GTA_CONFIG.groqApiKey.length > 10
      && GTA_CONFIG.groqApiKey.indexOf('YOUR_GROQ') === -1;
}

function callGroqServer(prompt, maxTokens) {
  try {
    const response = UrlFetchApp.fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'post',
      headers: {
        'Authorization': 'Bearer ' + GTA_CONFIG.groqApiKey,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: maxTokens || 220
      }),
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
      Logger.log('Groq non-200: ' + response.getResponseCode() + ' — ' + response.getContentText().substring(0, 200));
      return '';
    }
    const result = JSON.parse(response.getContentText());
    return (result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content || '').trim();
  } catch (err) {
    Logger.log('Groq call failed: ' + err.toString());
    return '';
  }
}

function generateWelcomeMessage(data) {
  if (!hasGroqKeyServer()) return '';
  const prompt =
    'Write a warm, personal 3-4 sentence welcome message for a student volunteer registering for the GTA International Fest (a Telangana cultural celebration). ' +
    'Speak directly to the student. Reference one or two specific things from their info to make it feel personal. ' +
    'Sound like a warm volunteer coordinator (not corporate). No greeting line ("Hi X,") and no closing — just the message body. ' +
    'No emojis. Plain text only.\n\n' +
    'Student details:\n' +
    '- Name: ' + (data.firstName || '') + ' ' + (data.lastName || '') + '\n' +
    '- Grade: ' + (data.gradeLevel || '') + '\n' +
    '- School: ' + (data.schoolName || '') + '\n' +
    '- Volunteer role: ' + (data.activityName || '') + '\n' +
    '- Hours pledged: ' + (data.hours || '') + '\n' +
    '- Notes about themselves (skills, languages, friends, etc.): ' + (data.description || '(none provided)');
  return callGroqServer(prompt, 220);
}

/* ============================================================
   _authorizeAndTest — RUN THIS ONCE FROM THE EDITOR
   --------------------------------------------------------------
   Triggers Google's authorization prompts for all permissions
   the script needs (Sheet, Email, External fetch). Also sends
   yourself a test confirmation email so you know everything works.
   --------------------------------------------------------------
   How to run:
     1. In the Apps Script editor, function dropdown (top toolbar)
     2. Pick "_authorizeAndTest"
     3. Click ▶ Run
     4. Authorize when prompted
     5. Check the Execution log (View → Logs) for results
     6. Check your inbox for the test email
   ============================================================ */
function _authorizeAndTest() {
  Logger.log('--- _authorizeAndTest starting ---');

  // 1. Test Sheet access
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    Logger.log('✓ Sheet access OK. Active sheet: "' + sheet.getName() + '" with ' + sheet.getLastRow() + ' rows.');
  } catch (e) {
    Logger.log('✗ Sheet access FAILED: ' + e.toString());
  }

  // 2. Test Groq (UrlFetchApp + Groq key)
  try {
    if (!hasGroqKeyServer()) {
      Logger.log('⚠ Groq key not set in GTA_CONFIG.groqApiKey — AI personalization will be skipped. (Emails still work without it.)');
    } else {
      const sample = generateWelcomeMessage({
        firstName: 'Test', lastName: 'Student',
        gradeLevel: '9th Grade', schoolName: 'Demo High School',
        activityName: 'Registration desk', hours: '4',
        description: 'I speak Telugu and English and love meeting new people.'
      });
      if (sample) {
        Logger.log('✓ Groq AI generation OK. Sample welcome:\n' + sample);
      } else {
        Logger.log('✗ Groq returned empty. Check the key, or check the execution Logs above.');
      }
    }
  } catch (e) {
    Logger.log('✗ Groq call FAILED: ' + e.toString());
  }

  // 3. Test sending email — sends a fake confirmation to YOUR account
  try {
    const myEmail = Session.getActiveUser().getEmail();
    if (!myEmail) {
      Logger.log('⚠ Could not get your email address — skipping email test.');
    } else {
      sendRegistrationEmail({
        firstName: 'Test', lastName: 'Volunteer',
        gradeLevel: '10th Grade', schoolName: 'Demo High School',
        studentEmail: myEmail,
        parentEmail: '',
        activityName: 'Registration desk',
        hours: '4',
        description: 'Test record from _authorizeAndTest. Safe to ignore.',
        submissionId: 'TEST-' + Date.now()
      });
      Logger.log('✓ Test confirmation email sent to ' + myEmail + '. Check your inbox.');
    }
  } catch (e) {
    Logger.log('✗ Email send FAILED: ' + e.toString());
  }

  Logger.log('--- _authorizeAndTest finished ---');
}

function generateAppreciation(data) {
  if (!hasGroqKeyServer()) return '';
  const prompt =
    'Write a warm, personal 2-3 sentence appreciation note thanking a student volunteer for their service at the GTA International Fest. ' +
    'Reference one or two specific things from their volunteer record to make every student feel seen. ' +
    'Sound genuine and warm, not corporate. No greeting line, no closing — just the message body. No emojis. Plain text only.\n\n' +
    'Volunteer record:\n' +
    '- Name: ' + (data.firstName || '') + ' ' + (data.lastName || '') + '\n' +
    '- School: ' + (data.school || '') + '\n' +
    '- Role they volunteered as: ' + (data.role || '') + '\n' +
    '- Hours volunteered: ' + (data.hoursCompleted || '') + '\n' +
    '- Notes about what they did: ' + (data.notes || '(no notes)');
  return callGroqServer(prompt, 180);
}
