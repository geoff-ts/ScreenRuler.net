// Public browser configuration. The MobileAPI key does NOT go in this file.
window.SCREEN_RULER_CONFIG = {
    lookupEndpoint: 'https://awenpzziosomkocigbri.supabase.co/functions/v1/mobileapi-lookup',
    calibrationTemplateEndpoint: 'https://awenpzziosomkocigbri.supabase.co/functions/v1/calibration-template',
    contactEndpoint: 'https://awenpzziosomkocigbri.supabase.co/functions/v1/contact',
    supabaseAnonKey: 'sb_publishable_Fhgy6fazaMkBCOR7dF0PWw_Tjv3oooP',

    // Create a Cloudflare Turnstile widget for screenruler.net, then place its
    // public site key here. The matching TURNSTILE_SECRET_KEY stays server-side.
    turnstileSiteKey: '',

    // AdSense values for the banner that follows the phone's physical bottom
    // edge (320 x 50 in portrait and 120 x 240 in landscape). Leave both empty
    // until the site is approved; empty values keep all advertising disabled.
    adsenseClient: 'ca-pub-4844506276858974',
    bottomAdSlot: '1113182365'
};
