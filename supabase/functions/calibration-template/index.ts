import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const adminClient = supabaseUrl && serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
    : null;
const rateLimitSalt = Deno.env.get('CALIBRATION_RATE_LIMIT_SALT') || serviceRoleKey || 'screen-ruler';
const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

function corsHeaders(origin: string | null) {
    // Opening the static site directly from disk produces Origin: null. This is
    // needed for local testing; the endpoint remains protected by validation,
    // private table access and its per-client rate limits.
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

function normaliseModel(model: string) {
    return model.toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function collectAliases(model: string, value: unknown) {
    const supplied = Array.isArray(value) ? value : [];
    return [...new Set([model, ...supplied]
        .filter((alias): alias is string => typeof alias === 'string')
        .map((alias) => alias.trim())
        .filter((alias) => alias.length >= 3 && alias.length <= 120)
    )].slice(0, 8);
}

// Keep this intentionally small and token-based: it catches clear profanity
// without blocking legitimate model names that merely contain similar letters.
const profanityPattern = /\b(?:asshole|bastard|bitch|cock|cunt|dick|fuck(?:er|ing|ed|s)?|piss(?:ed|ing)?|pussy|shit(?:ty|ting|s)?|slut|whore)\b/i;

function hasProfanity(values: string[]) {
    return values.some((value) => profanityPattern.test(value));
}

function canonicalResolution(width: number, height: number) {
    return width <= height ? { width, height } : { width: height, height: width };
}

function validNumber(value: unknown, min: number, max: number) {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function screenMatches(template: { screen_width: number; screen_height: number }, width: number, height: number) {
    const candidate = canonicalResolution(template.screen_width, template.screen_height);
    const requested = canonicalResolution(width, height);
    const difference = Math.abs(candidate.width - requested.width) + Math.abs(candidate.height - requested.height);
    return difference <= Math.max(requested.width, requested.height) * 0.06;
}

async function hashedRateBucket(request: Request, purpose: string) {
    const clientAddress = (request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip') || 'unknown')
        .split(',')[0]
        .trim();
    const day = new Date().toISOString().slice(0, 10);
    const bytes = new TextEncoder().encode(`${purpose}:${day}:${clientAddress}:${rateLimitSalt}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `calibration-template:${purpose}:${day}:${hash}`;
}

async function consumeQuota(request: Request, purpose: string, limit: number) {
    if (!adminClient) return null;
    const { data, error } = await adminClient.rpc('consume_device_calibration_template_quota', {
        p_bucket_key: await hashedRateBucket(request, purpose),
        p_limit: limit,
        p_window_seconds: 24 * 60 * 60
    });
    if (error) {
        console.error('Calibration template rate-limit check failed', error.message);
        return null;
    }
    return data === true;
}

async function findTemplateCandidates(normalizedModel: string) {
    const columns = 'id, model_hint, screen_width, screen_height, diagonal, calibrated_ppi, submission_count, updated_at, aliases, normalized_aliases';
    const [{ data: primaryMatches, error: primaryError }, { data: aliasMatches, error: aliasError }] = await Promise.all([
        adminClient!.from('device_calibration_templates').select(columns).eq('normalized_model', normalizedModel).limit(20),
        adminClient!.from('device_calibration_templates').select(columns).contains('normalized_aliases', [normalizedModel]).limit(20)
    ]);
    if (primaryError) throw primaryError;
    if (aliasError) throw aliasError;
    const candidates = [...(primaryMatches || []), ...(aliasMatches || [])];
    return [...new Map(candidates.map((template) => [template.id, template])).values()]
        .sort((a, b) => Number(b.submission_count) - Number(a.submission_count) ||
            String(b.updated_at).localeCompare(String(a.updated_at)));
}

serve(async (request) => {
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);
    if (allowedOrigins.length && origin && origin !== 'null' && !allowedOrigins.includes(origin)) {
        return json({ error: 'Origin not allowed' }, 403, origin);
    }
    if (!adminClient) return json({ error: 'Calibration templates are not configured on the server' }, 500, origin);

    try {
        const payload = await request.json();
        const action = payload?.action;
        const model = typeof payload?.model === 'string' ? payload.model.trim() : '';
        const normalizedModel = normaliseModel(model);
        const width = payload?.width;
        const height = payload?.height;
        const aliases = collectAliases(model, payload?.aliases);
        if (!['lookup', 'save', 'search'].includes(action)) return json({ error: 'Invalid template action' }, 400, origin);

        if (action === 'search') {
            const query = typeof payload?.query === 'string' ? payload.query.trim() : '';
            const normalizedQuery = normaliseModel(query);
            if (normalizedQuery.length < 3) return json({ templates: [] }, 200, origin);
            const allowed = await consumeQuota(request, 'search', 240);
            if (allowed === null) return json({ error: 'Template search protection is temporarily unavailable' }, 503, origin);
            if (!allowed) return json({ templates: [] }, 200, origin);

            const { data, error } = await adminClient
                .from('device_calibration_templates')
                .select('model_hint, screen_width, screen_height, diagonal, submission_count, updated_at, normalized_model, normalized_aliases')
                .order('submission_count', { ascending: false })
                .order('updated_at', { ascending: false })
                .limit(100);
            if (error) throw error;
            const templates = (data || [])
                .filter((template) => [template.normalized_model, ...(template.normalized_aliases || [])]
                    .some((alias) => String(alias).includes(normalizedQuery) || normalizedQuery.includes(String(alias))))
                .slice(0, 20)
                .map((template) => ({
                    model_hint: template.model_hint,
                    width: template.screen_width,
                    height: template.screen_height,
                    diagonal: Number(template.diagonal),
                    confidence: Math.min(1, Number(template.submission_count) / 3)
                }));
            return json({ templates }, 200, origin);
        }

        if (model.length < 3 || model.length > 120 || normalizedModel.length < 3) {
            return json({ error: 'A valid device model is required' }, 400, origin);
        }
        if (!validNumber(width, 100, 10000) || !validNumber(height, 100, 10000)) {
            return json({ error: 'A valid screen resolution is required' }, 400, origin);
        }

        if (action === 'lookup') {
            const allowed = await consumeQuota(request, 'lookup', 60);
            if (allowed === null) return json({ error: 'Template lookup protection is temporarily unavailable' }, 503, origin);
            if (!allowed) return json({ template: null }, 200, origin);

            const selected = (await findTemplateCandidates(normalizedModel))
                .find((template) => screenMatches(template, width, height));
            if (!selected) return json({ template: null }, 200, origin);
            return json({
                template: {
                    model_hint: selected.model_hint,
                    width: selected.screen_width,
                    height: selected.screen_height,
                    diagonal: Number(selected.diagonal),
                    confidence: Math.min(1, Number(selected.submission_count) / 3)
                }
            }, 200, origin);
        }

        const diagonal = payload?.diagonal;
        const calibratedPpi = payload?.ppi;
        if (!validNumber(diagonal, 2, 200) || !validNumber(calibratedPpi, 20, 2000)) {
            return json({ error: 'A valid calibrated display size is required' }, 400, origin);
        }
        if (hasProfanity(aliases)) {
            return json({ error: 'Please use a device model name without inappropriate language.' }, 400, origin);
        }
        const allowed = await consumeQuota(request, 'save', 5);
        if (allowed === null) return json({ error: 'Template saving is temporarily unavailable' }, 503, origin);
        if (!allowed) return json({ error: 'The daily calibration-save limit has been reached. Please try again tomorrow.' }, 429, origin);

        const screen = canonicalResolution(Math.round(width), Math.round(height));
        const normalizedAliases = aliases.map(normaliseModel).filter(Boolean);
        const existing = (await findTemplateCandidates(normalizedModel))
            .find((template) => template.screen_width === screen.width && template.screen_height === screen.height);

        if (existing) {
            const count = Number(existing.submission_count);
            const mergedAliases = [...new Set([...(existing.aliases || []), ...aliases])].slice(0, 8);
            const mergedNormalizedAliases = [...new Set([...(existing.normalized_aliases || []), ...normalizedAliases])].slice(0, 8);
            const { error } = await adminClient
                .from('device_calibration_templates')
                .update({
                    model_hint: model,
                    aliases: mergedAliases,
                    normalized_aliases: mergedNormalizedAliases,
                    diagonal: ((Number(existing.diagonal) * count) + diagonal) / (count + 1),
                    calibrated_ppi: ((Number(existing.calibrated_ppi) * count) + calibratedPpi) / (count + 1),
                    submission_count: count + 1,
                    updated_at: new Date().toISOString()
                })
                .eq('id', existing.id);
            if (error) throw error;
        } else {
            const { error } = await adminClient.from('device_calibration_templates').insert({
                model_hint: model,
                normalized_model: normalizedModel,
                aliases,
                normalized_aliases: normalizedAliases,
                screen_width: screen.width,
                screen_height: screen.height,
                diagonal,
                calibrated_ppi: calibratedPpi
            });
            if (error) throw error;
        }
        return json({ saved: true }, 200, origin);
    } catch (error) {
        console.error('Calibration template request failed', error);
        return json({ error: 'Calibration template request failed' }, 500, origin);
    }
});
