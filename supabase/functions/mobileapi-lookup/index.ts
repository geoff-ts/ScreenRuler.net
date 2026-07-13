import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const mobileApiKey = Deno.env.get('MOBILEAPI_API_KEY');
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const adminClient = supabaseUrl && serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
    : null;
const maxLookupsPerMonth = 25;
const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

function corsHeaders(origin: string | null) {
    const permittedOrigin = origin && allowedOrigins.includes(origin)
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

function parseScreenResolution(value: string) {
    // MobileAPI returns labels such as: 6.3", 1206x2622.
    const match = value.match(/(\d+(?:\.\d+)?)\D+(\d{3,5})\s*(?:x|\u00d7)\s*(\d{3,5})/i);
    if (!match) return null;
    return { diagonal: Number(match[1]), width: Number(match[2]), height: Number(match[3]) };
}

function resolutionMatches(candidate: { width: number; height: number }, width: number, height: number) {
    const direct = Math.abs(candidate.width - width) + Math.abs(candidate.height - height);
    const swapped = Math.abs(candidate.width - height) + Math.abs(candidate.height - width);
    const tolerance = Math.max(width, height) * 0.06;
    return Math.min(direct, swapped) <= tolerance;
}

function looksLikeModelNumber(value: string) {
    // Browser hints such as "motorola edge 40" are marketing names, whereas
    // identifiers such as "SM-S928B" and "A3520" are model numbers.
    return /^(?=.*\d)[a-z0-9_-]+$/i.test(value);
}

function auditCandidate(candidate: Record<string, unknown>) {
    // Device search responses may include large image payloads. They do not help
    // diagnose a screen match, so exclude them from the audit trail.
    const { image_b64, main_image_b64, ...details } = candidate;
    return details;
}

async function consumeQuota(bucketKey: string, limit: number, windowSeconds: number) {
    if (!adminClient) return null;
    const { data, error } = await adminClient.rpc('consume_mobileapi_lookup_quota', {
        p_bucket_key: bucketKey,
        p_limit: limit,
        p_window_seconds: windowSeconds
    });
    if (error) {
        console.error('Rate-limit check failed', error.message);
        return null;
    }
    return data === true;
}

async function writeAuditEntry(entry: Record<string, unknown>) {
    if (!adminClient) return;
    const { error } = await adminClient.from('mobileapi_lookup_audit').insert(entry);
    if (error) console.error('MobileAPI audit write failed', error.message);
}

serve(async (request) => {
    const origin = request.headers.get('Origin');
    let auditRequest: { model: string; width: number; height: number } | null = null;
    let providerCallStarted = false;
    let searchParameter: 'model_number' | 'name' = 'model_number';
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);
    if (allowedOrigins.length && origin && !allowedOrigins.includes(origin)) {
        return json({ error: 'Origin not allowed' }, 403, origin);
    }
    if (!mobileApiKey) return json({ error: 'MobileAPI is not configured on the server' }, 500, origin);

    try {
        const { model, width, height } = await request.json();
        if (typeof model !== 'string' || model.trim().length < 2 || model.length > 100) {
            return json({ error: 'A valid device model is required' }, 400, origin);
        }
        if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100) {
            return json({ error: 'A valid screen resolution is required' }, 400, origin);
        }
        auditRequest = { model: model.trim(), width, height };

        // A calendar-month key creates a firm shared ceiling, independent of the
        // number of visitors or IP addresses using the public lookup endpoint.
        const monthKey = new Date().toISOString().slice(0, 7);
        const monthlyQuotaAvailable = await consumeQuota(`mobileapi:month:${monthKey}`, maxLookupsPerMonth, 31 * 24 * 60 * 60);
        if (monthlyQuotaAvailable === null) return json({ error: 'Lookup protection is temporarily unavailable' }, 503, origin);
        if (!monthlyQuotaAvailable) {
            return json({ error: 'This month\'s free device-match allowance has been used. Please calibrate manually.' }, 429, origin);
        }

        const url = new URL('https://api.mobileapi.dev/devices/search/');
        searchParameter = looksLikeModelNumber(model.trim()) ? 'model_number' : 'name';
        url.searchParams.set(searchParameter, model.trim());
        url.searchParams.set('exact', 'true');

        providerCallStarted = true;
        const apiResponse = await fetch(url, {
            headers: { 'Authorization': `Token ${mobileApiKey}` }
        });
        if (!apiResponse.ok) {
            await writeAuditEntry({
                requested_model: model.trim(),
                requested_screen_width: width,
                requested_screen_height: height,
                provider_status: apiResponse.status,
                match_found: false
            });
            return json({ error: 'Device service lookup failed' }, 502, origin);
        }

        const payload = await apiResponse.json();
        const candidates = Array.isArray(payload.devices) ? payload.devices : [];
        const compatibleCandidates = candidates.map((candidate: Record<string, unknown>) => {
            const screen = typeof candidate.screen_resolution === 'string'
                ? parseScreenResolution(candidate.screen_resolution)
                : null;
            return { candidate, screen };
        }).filter(({ screen }) => screen && resolutionMatches(screen, width, height));
        const device = compatibleCandidates
            .sort((a, b) => Number.parseFloat(String(b.candidate.match_certainty || 0)) - Number.parseFloat(String(a.candidate.match_certainty || 0)))[0]?.candidate;

        if (!device) {
            await writeAuditEntry({
                requested_model: model.trim(),
                requested_screen_width: width,
                requested_screen_height: height,
                provider_status: apiResponse.status,
                match_found: false,
                provider_response: payload,
                mobileapi_match: {
                    search_parameter: searchParameter,
                    candidates: candidates.map(auditCandidate)
                }
            });
            return json({ match: null }, 200, origin);
        }
        const screen = parseScreenResolution(device.screen_resolution);
        if (!screen) {
            await writeAuditEntry({
                requested_model: model.trim(),
                requested_screen_width: width,
                requested_screen_height: height,
                provider_status: apiResponse.status,
                match_found: false
            });
            return json({ match: null }, 200, origin);
        }
        await writeAuditEntry({
            requested_model: model.trim(),
            requested_screen_width: width,
            requested_screen_height: height,
            provider_status: apiResponse.status,
            match_found: true,
            matched_brand: device.manufacturer_name || device.brand_name || 'Unknown',
            matched_name: device.name,
            matched_diagonal: screen.diagonal,
            matched_screen_width: screen.width,
            matched_screen_height: screen.height,
            provider_response: payload,
            mobileapi_match: {
                search_parameter: searchParameter,
                candidate: auditCandidate(device)
            }
        });
        return json({
            match: {
                brand: device.manufacturer_name || device.brand_name || 'Unknown',
                name: device.name,
                diagonal: screen.diagonal,
                width: screen.width,
                height: screen.height,
                confidence: 1
            }
        }, 200, origin);
    } catch (error) {
        // A provider request can still count against MobileAPI's allowance even if a
        // network or response-parsing error prevents us from processing its reply.
        if (providerCallStarted && auditRequest) {
            await writeAuditEntry({
                requested_model: auditRequest.model,
                requested_screen_width: auditRequest.width,
                requested_screen_height: auditRequest.height,
                match_found: false,
                mobileapi_match: {
                    error: error instanceof Error ? error.message : 'Unknown provider lookup error'
                }
            });
            return json({ error: 'Device service lookup failed' }, 502, origin);
        }
        return json({ error: 'Invalid lookup request' }, 400, origin);
    }
});
