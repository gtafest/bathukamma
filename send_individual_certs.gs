/* ============================================================
   ONE-OFF SCRIPT — send individual cert emails with PNG + PDF attached
   --------------------------------------------------------------
   STEP 1: upload the 4 cert files to Google Drive (NOTE: they
           must be in the DRIVE OF THE ACCOUNT THAT RUNS THIS
           SCRIPT — i.e. gtaadmin2026@gmail.com if that's the
           script owner). Filenames must match exactly:
             GTA_Certificate_Abhinav_Bujula_8hrs.png
             GTA_Certificate_Abhinav_Bujula_8hrs.pdf
             GTA_Certificate_Gagana_Saanvi_Yerranagu_8hrs.png
             GTA_Certificate_Gagana_Saanvi_Yerranagu_8hrs.pdf

   STEP 2: paste this whole block into your Apps Script project
           (one place only).

   STEP 3: run diagnoseCertFiles() FIRST. It tells you what the
           script can and can't see. If it can't see the files,
           it'll print the running account so you know where to
           upload them.

   STEP 4: once diagnose says "ALL 4 files found", run
           sendIndividualCertEmails().
   ============================================================ */

/* -------- DIAGNOSTIC: tells you who's running + what files are visible -------- */
function diagnoseCertFiles() {
  let me = '(unknown)';
  try { me = Session.getEffectiveUser().getEmail(); } catch (e) {}
  Logger.log('======================================');
  Logger.log('Script is running as: ' + me);
  Logger.log('======================================');

  const expected = [
    'GTA_Certificate_Abhinav_Bujula_8hrs.png',
    'GTA_Certificate_Abhinav_Bujula_8hrs.pdf',
    'GTA_Certificate_Gagana_Saanvi_Yerranagu_8hrs.png',
    'GTA_Certificate_Gagana_Saanvi_Yerranagu_8hrs.pdf'
  ];

  let foundCount = 0;
  expected.forEach(function(name) {
    const it = DriveApp.getFilesByName(name);
    if (it.hasNext()) {
      const f = it.next();
      Logger.log('✓ FOUND  ' + name + '  (id=' + f.getId() + ', owner=' + (f.getOwner() ? f.getOwner().getEmail() : '?') + ')');
      foundCount++;
    } else {
      Logger.log('✗ MISSING  ' + name);
    }
  });

  Logger.log('======================================');
  Logger.log('Result: ' + foundCount + ' of 4 files visible to this script.');

  if (foundCount < 4) {
    Logger.log('');
    Logger.log('Listing ALL files in this Drive containing "Certificate" or "GTA" to help you locate them:');
    // Cap at 50 so the log doesn't explode
    let listed = 0;
    const it = DriveApp.searchFiles('title contains "Certificate" or title contains "GTA"');
    while (it.hasNext() && listed < 50) {
      const f = it.next();
      Logger.log('  • ' + f.getName() + '  (mime=' + f.getMimeType() + ', id=' + f.getId() + ')');
      listed++;
    }
    if (listed === 0) {
      Logger.log('  (no files at all match "Certificate" or "GTA" in this Drive)');
    }
    Logger.log('');
    Logger.log('NEXT STEP:');
    Logger.log('  Upload the missing files to the Drive of ' + me + '. (You must be signed in as');
    Logger.log('  ' + me + ' when you upload them, OR share them with that account.)');
    Logger.log('  Alternative: see "FILE_ID_OVERRIDES" near the top of the function below — paste');
    Logger.log('  the Drive file IDs directly to skip the name-based lookup.');
  } else {
    Logger.log('All 4 files visible. You can now run sendIndividualCertEmails().');
  }
  return foundCount + '/4 files found. See log.';
}


/* -------- THE SENDER -------- */
function sendIndividualCertEmails() {

  // OPTIONAL: if name-lookup keeps failing, paste the Drive file IDs here.
  // Get an ID by right-clicking the file in Drive → Get link → the long string
  // between /d/ and /view in the URL. Leave empty to use filename lookup.
  const FILE_ID_OVERRIDES = {
    'GTA_Certificate_Abhinav_Bujula_8hrs.png':           '',
    'GTA_Certificate_Abhinav_Bujula_8hrs.pdf':           '',
    'GTA_Certificate_Gagana_Saanvi_Yerranagu_8hrs.png':  '',
    'GTA_Certificate_Gagana_Saanvi_Yerranagu_8hrs.pdf':  ''
  };

  const CERTS = [
    {
      name: 'Abhinav Bujula',
      firstName: 'Abhinav',
      hours: 8,
      to: 'abhinavbujula@gmail.com',
      cc: 'nandini_reddy1@yahoo.com',
      pngFile: 'GTA_Certificate_Abhinav_Bujula_8hrs.png',
      pdfFile: 'GTA_Certificate_Abhinav_Bujula_8hrs.pdf'
    },
    {
      name: 'Gagana Saanvi Yerranagu',
      firstName: 'Gagana',
      hours: 8,
      to: 'ykalyankumar2016@gmail.com',
      cc: '',
      pngFile: 'GTA_Certificate_Gagana_Saanvi_Yerranagu_8hrs.png',
      pdfFile: 'GTA_Certificate_Gagana_Saanvi_Yerranagu_8hrs.pdf'
    }
  ];

  const CFG = {
    dataDeletionDate: 'Sunday, June 14, 2026',
    contactEmail: 'gtaadmin2026@gmail.com',
    fromName: 'Global Telangana Association — Atlanta'
  };

  let sent = 0;
  let failed = 0;
  CERTS.forEach(function(c) {
    try {
      const pngBlob = _ic_getBlob(c.pngFile, FILE_ID_OVERRIDES);
      const pdfBlob = _ic_getBlob(c.pdfFile, FILE_ID_OVERRIDES);

      const subject = '🎉 Your GTA Volunteer Certificate — ' + c.name + ' · ' + c.hours + ' hours';
      const plain = _ic_buildPlain(c, CFG);
      const html  = _ic_buildHtml(c, CFG);

      const options = {
        name: CFG.fromName,
        htmlBody: html,
        attachments: [pngBlob, pdfBlob]
      };
      if (c.cc && c.cc.indexOf('@') > -1) options.cc = c.cc;

      MailApp.sendEmail(c.to, subject, plain, options);
      Logger.log('Sent: ' + c.name + '  to=' + c.to + '  cc=' + (c.cc || '(none)'));
      sent++;
    } catch (err) {
      Logger.log('FAILED for ' + c.name + ': ' + err.toString());
      failed++;
    }
  });
  const summary = 'Done. sent=' + sent + ' failed=' + failed + ' quotaRemaining=' + MailApp.getRemainingDailyQuota();
  Logger.log(summary);
  return summary;
}

function _ic_getBlob(name, overrides) {
  // If a Drive file ID was pasted into the override map, use that directly
  if (overrides && overrides[name]) {
    try {
      return DriveApp.getFileById(overrides[name]).getBlob();
    } catch (e) {
      throw new Error('File ID lookup failed for "' + name + '" (id=' + overrides[name] + '): ' + e.toString());
    }
  }
  // Otherwise search the whole Drive by name
  const files = DriveApp.getFilesByName(name);
  if (!files.hasNext()) throw new Error('Drive file not found: "' + name + '". Upload it to your Drive first (run diagnoseCertFiles for details).');
  const file = files.next();
  if (files.hasNext()) {
    Logger.log('NOTE: multiple files named "' + name + '" found in Drive. Using the first one (id=' + file.getId() + ').');
  }
  return file.getBlob();
}

function _ic_buildPlain(c, cfg) {
  return (
    'Hi ' + c.firstName + ',\n\n' +
    'On behalf of the entire Global Telangana Association family, THANK YOU for volunteering at the GTA International Fest 2026!\n\n' +
    'Volunteers like you are the foundation of every GTA event — without your time, energy, and spirit of seva, none of this would be possible. ' +
    'A heartfelt thank-you also to your parents and guardians for the support and encouragement that gave you the courage to step up and serve.\n\n' +
    '─────────────────────────────\n' +
    'YOUR DIGITAL VOLUNTEER CERTIFICATE\n' +
    '─────────────────────────────\n' +
    'Attached to this email you will find your personalized GTA Volunteer Certificate in TWO formats:\n' +
    '  • ' + c.pdfFile + '  — for printing or attaching to college / school applications\n' +
    '  • ' + c.pngFile + '  — for emailing, social media, or quick previews\n\n' +
    'Hours verified: ' + c.hours + '\n\n' +
    'NEED ANY CHANGES?\n' +
    'If anything on the certificate needs adjusting — a misspelling, a different name format, an updated hours count, anything at all — just reply to this email or write to ' +
    cfg.contactEmail + ' and someone from the GTA team will be happy to help.\n\n' +
    '─────────────────────────────\n' +
    'IMPORTANT — DATA RETENTION\n' +
    '─────────────────────────────\n' +
    'To protect your privacy, the registration data we hold (your name, contact info, hours) will be automatically deleted from our system on ' +
    cfg.dataDeletionDate + '. Please save your certificate before then. Even after that date you can still reach us at ' +
    cfg.contactEmail + ' for any future questions or future volunteering opportunities.\n\n' +
    'Thank you once again from the entire GTA family. We are excited to see you at future GTA events and community-service initiatives in the coming months — your spirit of seva is what keeps our community strong.\n\n' +
    'With deep gratitude,\n' +
    'Global Telangana Association — Atlanta\n' +
    cfg.contactEmail + '\n' +
    'www.gtaatlanta.org'
  );
}

function _ic_buildHtml(c, cfg) {
  return (
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif;max-width:640px;color:#1f2937;line-height:1.6">' +
      '<div style="background:linear-gradient(135deg,#7a0c16,#c1272d 60%,#ff6b35);color:#fff;padding:26px 24px;border-radius:10px 10px 0 0;text-align:center">' +
        '<div style="font-size:12px;letter-spacing:2px;opacity:0.85">GLOBAL TELANGANA ASSOCIATION · ATLANTA</div>' +
        '<div style="font-size:26px;font-weight:800;margin-top:8px">🎉 Your Volunteer Certificate</div>' +
        '<div style="font-size:14px;margin-top:6px;color:#ffd166">' + c.hours + ' hours · GTA International Fest 2026</div>' +
      '</div>' +
      '<div style="background:#fff8ec;padding:26px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px">' +
        '<p>Hi <strong>' + c.firstName + '</strong>,</p>' +
        '<p>On behalf of the entire <strong>Global Telangana Association family</strong>, THANK YOU for volunteering at the GTA International Fest 2026!</p>' +
        '<p>Volunteers like you are the foundation of every GTA event — without your time, energy, and spirit of <em>seva</em>, none of this would be possible. A heartfelt thank-you also to your parents and guardians for the support and encouragement that gave you the courage 