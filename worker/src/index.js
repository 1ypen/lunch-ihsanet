import { DurableObject } from 'cloudflare:workers';

// Общий список заказов. Один Durable Object на всё — заказов в день десятки,
// зато чтение сразу видит последнюю запись (в отличие от KV).
//
//   GET    /orders/:day        → [{id, name, main, soup, drink, note, ts}]
//   PUT    /orders/:day/:id    ← тот же объект, создать или обновить
//   DELETE /orders/:day/:id

const ALLOWED_ORIGINS = ['https://1ypen.github.io'];
const KEEP_DAYS = 14;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9]{1,16}$/;

export class Orders extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS orders (
      day  TEXT NOT NULL,
      id   TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (day, id)
    )`);
  }

  list(day) {
    return this.sql.exec('SELECT data FROM orders WHERE day = ?', day)
      .toArray().map(r => JSON.parse(r.data));
  }

  put(day, order) {
    this.sql.exec('INSERT OR REPLACE INTO orders (day, id, data) VALUES (?, ?, ?)',
      day, order.id, JSON.stringify(order));
    // Старые дни никому не нужны — подчищаем заодно с записью
    const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
    this.sql.exec('DELETE FROM orders WHERE day < ?', cutoff);
  }

  del(day, id) {
    this.sql.exec('DELETE FROM orders WHERE day = ? AND id = ?', day, id);
  }
}

function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
  return ok ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  } : { 'Vary': 'Origin' };
}

const str = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';

// Принимаем только известные поля и обрезаем длины — сюда пишет кто угодно
function cleanOrder(id, body) {
  const o = {
    id,
    name: str(body.name, 60),
    main: str(body.main, 32),
    soup: str(body.soup, 32),
    drink: str(body.drink, 32),
    note: str(body.note, 200),
    ts: Number.isFinite(body.ts) ? body.ts : Date.now(),
  };
  return o.name && o.main && o.soup && o.drink ? o : null;
}

export default {
  async fetch(request, env) {
    const headers = cors(request.headers.get('Origin'));
    const reply = (body, status = 200) => Response.json(body, { status, headers });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const [, root, day, id] = new URL(request.url).pathname.split('/');
    if (root !== 'orders' || !DAY_RE.test(day || '')) return reply({ error: 'not found' }, 404);

    const stub = env.ORDERS.get(env.ORDERS.idFromName('ihsanet'));

    if (request.method === 'GET' && !id) return reply(await stub.list(day));

    if (!ID_RE.test(id || '')) return reply({ error: 'bad id' }, 400);

    if (request.method === 'PUT') {
      let body;
      try { body = await request.json(); } catch (_) { return reply({ error: 'bad json' }, 400); }
      const order = cleanOrder(id, body || {});
      if (!order) return reply({ error: 'name, main, soup, drink required' }, 400);
      await stub.put(day, order);
      return reply(order);
    }

    if (request.method === 'DELETE') {
      await stub.del(day, id);
      return reply({ ok: true });
    }

    return reply({ error: 'method not allowed' }, 405);
  },
};
