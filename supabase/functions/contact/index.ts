import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const adminClient = supabaseUrl && serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
    : null;
const turnstileSecret = Deno.env.get('TURNSTILE_SECRET_KEY');
const resendApiKey = Deno.env.get('RESEND_API_KEY');
const fromAddress = Deno.env.get('CONTACT_FROM_EMAIL');
const rateLimitSalt = Deno.env.get('CONTACT_RATE_LIMIT_SALT') || serviceRoleKey || 'screen-ruler';
const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
const recipient = 'geoffrey.brom@gmail.com';

function corsHeaders(origin: string | null) {
    const permittedOrigin = origin === 'null'
        ? '*'
        : origin && allowedOrigins.includes(origin)
        ? origin
        : (allowedOrigins[0] || origin || '*');
    return {
        'Access-Control-Allow-Origin': permittedOrigin,
        'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
    };
}

function json(body: unknown, status: number, origin: string | null) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) }
    });
}

function validText(value: unknown, min: number, max: number) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
}

function validEmail(value: unknown) {
    const email = validText(value, 3, 254);
    // This deliberately accepts legitimate international/local addressing while
    // still rejecting malformed values and control characters.
    return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

async function visitorBucket(request: Request) {
    const clientAddress = (request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip') || 'unknown')
        .split(',')[0]
        .trim();
    const hour = new Date().toISOString().slice(0, 13);
    const bytes = new TextEncoder().encode(`contact:${hour}:${clientAddress}:${rateLimitSalt}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `contact:${hour}:${hash}`;
}

async function consumeQuota(request: Request) {
    if (!adminClient) return null;
    const { data, error } = await adminClient.rpc('consume_contact_form_quota', {
        p_bucket_key: await visitorBucket(request),
        p_limit: 3,
        p_window_seconds: 60 * 60
    });
    if (error) {
        console.error('Contact form rate-limit check failed', error.message);
        return null;
    }
    return data === true;
}

async function verifyTurnstile(token: string, request: Request) {
    if (!turnstileSecret) return false;
    const remoteip = (request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip') || '')
        .split(',')[0]
        .trim();
    const form = new FormData();
    form.set('secret', turnstileSecret);
    form.set('response', token);
    if (remoteip) form.set('remoteip', remoteip);
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: form
    });
    if (!response.ok) return false;
    const result = await response.json();
    return result?.success === true && result?.action === 'contact';
}

serve(async (request) => {
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);
    if (allowedOrigins.length && origin && origin !== 'null' && !allowedOrigins.includes(origin)) {
        return json({ error: 'Origin not allowed' }, 403, origin);
    }
    if (!adminClient || !turnstileSecret || !resendApiKey || !fromAddress) {
        console.error('Contact form is missing server configuration');
        return json({ error: 'The contact form is temporarily unavailable' }, 503, origin);
    }

    try {
        const payload = await request.json();
        const name = validText(payload?.name, 2, 80);
        const email = validEmail(payload?.email);
        const subject = validText(payload?.subject, 3, 140);
        const message = validText(payload?.message, 20, 5000);
        const honeypot = typeof payload?.website === 'string' ? payload.website.trim() : '';
        const formStartedAt = Number(payload?.formStartedAt);
        const elapsed = Date.now() - formStartedAt;

        // Pretend success for obvious bots so they do not tune their payloads.
        if (honeypot || !Number.isFinite(elapsed) || elapsed < 3000 || elapsed > 2 * 60 * 60 * 1000) {
            return json({ sent: true }, 202, origin);
        }
        if (!name || !email || !subject || !message) return json({ error: 'Please complete every field with valid information' }, 400, origin);

        const token = typeof payload?.turnstileToken === 'string' ? payload.turnstileToken : '';
        if (!token || !(await verifyTurnstile(token, request))) {
            return json({ error: 'The spam check failed. Please refresh the page and try again.' }, 400, origin);
        }
        const allowed = await consumeQuota(request);
        if (allowed === null) return json({ error: 'The contact form is temporarily unavailable' }, 503, origin);
        if (!allowed) return json({ error: 'Please wait before sending another message.' }, 429, origin);

        const mailResponse = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: fromAddress,
                to: [recipient],
                reply_to: email,
                subject: `[Screen Ruler] ${subject.replace(/[\r\n]+/g, ' ')}`,
                text: `From: ${name}\nEmail: ${email}\n\n${message}`
            })
        });
        if (!mailResponse.ok) {
            console.error('Resend rejected contact email', await mailResponse.text());
            return json({ error: 'Your message could not be sent. Please try again later.' }, 502, origin);
        }
        return json({ sent: true }, 200, origin);
    } catch (error) {
        console.error('Contact form request failed', error);
        return json({ error: 'Your message could not be sent. Please try again later.' }, 500, origin);
    }
});
