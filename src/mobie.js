import { HttpError, requestJson } from './http.js';

function decimalNumber(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : NaN;
}

function location(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${name} must be a location object.`);
  const longitude = decimalNumber(value.longitude);
  const latitude = decimalNumber(value.latitude);
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180 ||
      !Number.isFinite(latitude) || Math.abs(latitude) > 90) {
    throw new HttpError(400, `${name} needs numeric longitude (-180..180) and latitude (-90..90).`);
  }
  const result = { longitude, latitude };
  if (typeof value.publicName !== 'string' || !value.publicName.trim()) throw new HttpError(400, `${name}.publicName is required.`);
  for (const key of ['publicName', 'addressLine']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' || value[key].length > 500) throw new HttpError(400, `${name}.${key} must be a string of at most 500 characters.`);
      result[key] = value[key];
    }
  }
  return result;
}

export function ridePayload(value) {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'A ride request object is required.');
  if (typeof value.time !== 'string' || !/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.time) || !Number.isFinite(Date.parse(value.time))) {
    throw new HttpError(400, 'time must be an ISO-8601 datetime with Z or an explicit offset (e.g. +02:00).');
  }
  const seats = decimalNumber(value.seatsRequested ?? 1);
  if (!Number.isInteger(seats) || seats < 1 || seats > 8) throw new HttpError(400, 'seatsRequested must be an integer from 1 to 8.');
  return { departure: location(value.departure, 'departure'), destination: location(value.destination, 'destination'), time: value.time, seatsRequested: seats };
}

function ridePath(id) {
  return `/rides/${identifier(id)}`;
}

function identifier(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new HttpError(400, 'Invalid ride, booking or request ID.');
  return encodeURIComponent(id);
}

export function callerHeaders(context) {
  const phone = context?.phone;
  const webTest = (phone === undefined || phone === '') && context?.callType === 'webCall';
  if ((!webTest && (typeof phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(phone))) ||
      typeof context?.callId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(context.callId)) {
    throw new HttpError(400, 'Supply a valid X-Mobie-Caller-Phone (or explicit X-Mobie-Call-Type: webCall) and X-Mobie-Call-Id.');
  }
  return {
    ...(webTest ? { 'X-Mobie-Call-Type': 'webCall' } : { 'X-Mobie-Caller-Phone': phone }),
    'X-Mobie-Call-Id': context.callId,
  };
}

function confirmation(payload) {
  if (payload?.confirmed !== true) throw new HttpError(400, 'Explicit caller confirmation is required (confirmed: true).');
}

export function createMobieClient({ baseUrl, secret, fetch = globalThis.fetch }) {
  async function request(path, context, method = 'GET', body, write = false) {
    const headers = { Authorization: `Bearer ${secret}`, ...callerHeaders(context), 'Content-Type': 'application/json', Accept: 'application/json' };
    if (write) {
      if (typeof context.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(context.idempotencyKey)) {
        throw new HttpError(400, 'Supply a stable Idempotency-Key for this confirmed action; reuse it for retries.');
      }
      headers['Idempotency-Key'] = context.idempotencyKey;
    }
    return requestJson(`${baseUrl.replace(/\/$/, '')}/integrations/voice${path}`, {
      method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, { fetch, service: 'mobie API', safeCodes: ['AMBIGUOUS_CALLER'] });
  }
  return {
    caller: context => request('/caller', context),
    async nearbyRides(payload, context) { return request('/rides/nearby', context, 'POST', { departure: location(payload?.departure, 'departure') }); },
    async searchRides(payload, context) { return request('/rides/search', context, 'POST', ridePayload(payload)); },
    async riderRideDetails(id, context) { return request(`${ridePath(id)}/rider-detail`, context); },
    async joinRide(id, payload, context) {
      confirmation(payload);
      return request(`${ridePath(id)}/join-detailed`, context, 'POST', { ...ridePayload(payload), confirmed: true }, true);
    },
    async createRequest(payload, context) {
      confirmation(payload);
      return request('/ride-requests', context, 'POST', { ...ridePayload(payload), confirmed: true }, true);
    },
    requests: (context, openOnly = false) => request(`/ride-requests${openOnly ? '?openOnly=true' : ''}`, context),
    async bookings(page, context) {
      if (!Number.isSafeInteger(page) || page < 0) throw new HttpError(400, 'page must be a nonnegative integer.');
      return request(`/bookings?page=${page}`, context);
    },
    booking: (id, context) => request(`/bookings/${identifier(id)}`, context),
    async withdrawRequest(id, payload, context) {
      confirmation(payload);
      return request(`/ride-requests/${identifier(id)}/withdraw`, context, 'POST', { confirmed: true }, true);
    },
    async cancelBooking(rideId, bookingId, payload, context) {
      confirmation(payload);
      return request(`${ridePath(rideId)}/bookings/${identifier(bookingId)}/cancel`, context, 'POST', { confirmed: true }, true);
    },
  };
}
