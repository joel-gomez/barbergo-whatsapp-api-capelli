// ==========================================================================
// server_capelli.js — SERVIDOR EXCLUSIVO E INDEPENDIENTE DE CAPELLI
// ==========================================================================

const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');
const cron    = require('node-cron');

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY_JSON);
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db  = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const PORT            = process.env.PORT || 10000;

const COMPANY_ID   = 'nI6ilcu8qPbH3xiXXsM7';
const LOCATION_IDS = ['20aikKXImqJbfPaqXfG6'];

const BARBERGO_SERVER_URL = process.env.BARBERGO_SERVER_URL || 'https://barbergo-whatsapp-api-production.up.railway.app';

const TEMPLATES = {
  solicitud:      'solicitud_reserva_capelli_v1',
  confirmada:     'reserva_confirmada_capelli_v3',
  cancelada:      'reserva_cancelada_capelli_v1',
  recordatorio:   'recordatorio_confirmacion_capelli_v2',
  calificacion:   'calificar_barbero_capelli_v1',
  agradecimiento: 'agradecimiento_capelli_v1'
};

// =====================================================================
// 🕐 HORA DE PARAGUAY — UTC-3 FIJO
// =====================================================================
const PY_OFFSET_MIN = -180; // UTC-3

function _ahoraPY(offsetDias = 0) {
  return new Date(Date.now() + PY_OFFSET_MIN * 60 * 1000 + offsetDias * 86400000);
}

function fechaPY(offsetDias = 0) {
  const d = _ahoraPY(offsetDias);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function horaParaguay() {
  const d = _ahoraPY();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  return {
    dateStr: fechaPY(),
    hour, minute,
    minutosDelDia: hour * 60 + minute,
    timeStr: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  };
}

function minutosHastaTurno(startTimeStr, pyNow) {
  if (!startTimeStr) return null;
  const [h, m] = startTimeStr.split(':').map(Number);
  return (h * 60 + m) - pyNow.minutosDelDia;
}

// 🔧 A pedido — igual que minutosHastaTurno, pero cruzando la FECHA
// completa del turno (no solo la hora del día), para que funcione bien
// sin importar cuántos días falten. _ahoraPY() ya devuelve "ahora"
// corrido a hora de Paraguay pero representado como si fuera UTC — acá
// construimos la fecha del turno de la misma manera, para que la resta
// dé el minutaje real sin líos de zona horaria.
function minutosHastaTurnoCompleto(fechaStr, horaStr) {
  if (!fechaStr || !horaStr) return null;
  try {
    const turnoNaive = new Date(`${fechaStr}T${horaStr}:00Z`);
    if (isNaN(turnoNaive.getTime())) return null;
    const ahoraNaive = _ahoraPY();
    return Math.round((turnoNaive.getTime() - ahoraNaive.getTime()) / 60000);
  } catch (e) {
    return null;
  }
}

async function registrarAlcanceMeta(phone) {
  try {
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    if (!cleanPhone) return;
    const hoy = fechaPY();
    await db.collection('meta_reach_daily').doc(hoy).set({
      numeros: { [cleanPhone]: admin.firestore.FieldValue.serverTimestamp() },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) {
    console.error('⚠️ [Capelli] [Alcance Meta] No se pudo registrar:', e.message);
  }
}

// =====================================================================
// 🕐 VENTANA DE SERVICIO REAL (24hs) — mismo mecanismo que server.js:
// un mensaje es gratis si ese cliente le escribió a Capelli en las
// últimas 24hs, sin importar el tipo de mensaje. Confirmado contra las
// estadísticas reales de Meta Business Manager.
// =====================================================================
async function registrarMensajeEntrante(phone, companyId = COMPANY_ID) {
  try {
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    if (!cleanPhone) return;
    await db.collection('client_windows').doc(`${companyId}_${cleanPhone}`).set({
      companyId, phone: cleanPhone,
      lastMessageAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) {
    console.error('⚠️ [Capelli] [Ventana 24hs] No se pudo registrar:', e.message);
  }
}

// 💬 Guarda el texto CRUDO entrante para la vista de chat del panel.
async function registrarMensajeChat(phone, companyId, texto) {
  try {
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    if (!cleanPhone || !companyId || !texto) return;
    await db.collection('chat_messages').add({
      companyId, phone: cleanPhone, direction: 'inbound',
      text: String(texto).slice(0, 1000),
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error('⚠️ [Capelli] [Chat] No se pudo registrar mensaje entrante:', e.message);
  }
}

async function ventanaAbierta(phone, companyId = COMPANY_ID) {
  try {
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    if (!cleanPhone) return false;
    const snap = await db.collection('client_windows').doc(`${companyId}_${cleanPhone}`).get();
    if (!snap.exists) return false;
    const lastMessageAt = snap.data().lastMessageAt;
    if (!lastMessageAt) return false;
    const fecha = lastMessageAt.toDate ? lastMessageAt.toDate() : new Date(lastMessageAt);
    const horasDesde = (Date.now() - fecha.getTime()) / (1000 * 60 * 60);
    return horasDesde < 24;
  } catch (e) {
    console.error('⚠️ [Capelli] [Ventana 24hs] Error consultando:', e.message);
    return false;
  }
}

// =====================================================================
// 📅 CICLO DE FACTURACIÓN DE CAPELLI — mismo mecanismo que server.js
// compartido: en vez de reiniciar el cupo el día 1 de cada mes
// calendario, se ancla a companies/{COMPANY_ID}.paidUntil (la fecha de
// vencimiento que se actualiza a mano en el SuperAdmin cada vez que
// Capelli paga). Mientras paidUntil no cambie, sigue siendo el mismo
// ciclo; el día que se actualiza, arranca uno nuevo solo.
// Se cachea 60s para no pegarle a Firestore en cada mensaje.
// =====================================================================
let PAID_UNTIL_CACHE = { value: undefined, cachedAt: 0 };
const PAID_UNTIL_TTL_MS = 60 * 1000;

async function obtenerPaidUntil() {
  const ahora = Date.now();
  if (PAID_UNTIL_CACHE.value !== undefined && (ahora - PAID_UNTIL_CACHE.cachedAt) < PAID_UNTIL_TTL_MS) {
    return PAID_UNTIL_CACHE.value;
  }
  try {
    const snap = await db.collection('companies').doc(COMPANY_ID).get();
    const paidUntil = snap.exists ? (snap.data().paidUntil || null) : null;
    PAID_UNTIL_CACHE = { value: paidUntil, cachedAt: ahora };
    return paidUntil;
  } catch (e) {
    console.error('⚠️ [Capelli] Error obteniendo paidUntil:', e.message);
    return null;
  }
}

// 🧪 Flag de prueba — agrupa todos los cambios de ahorro de mensajes
// que todavía se están validando (texto libre en vez de plantilla).
// Se activa desde SuperAdmin, empresa por empresa — Capelli solo lo
// usa si Joel lo activó explícitamente para esta empresa puntual.
let PRUEBA_FLUJO_CACHE = { value: undefined, cachedAt: 0 };
const PRUEBA_FLUJO_TTL_MS = 60 * 1000;

async function pruebaFlujoWhatsappActiva() {
  const ahora = Date.now();
  if (PRUEBA_FLUJO_CACHE.value !== undefined && (ahora - PRUEBA_FLUJO_CACHE.cachedAt) < PRUEBA_FLUJO_TTL_MS) {
    return PRUEBA_FLUJO_CACHE.value;
  }
  try {
    const snap = await db.collection('companies').doc(COMPANY_ID).get();
    const activa = !!(snap.exists && snap.data().enabledFeatures?.pruebaFlujoWhatsapp);
    PRUEBA_FLUJO_CACHE = { value: activa, cachedAt: ahora };
    return activa;
  } catch (e) {
    console.error('⚠️ [Capelli] Error obteniendo pruebaFlujoWhatsapp:', e.message);
    return false;
  }
}

function obtenerCicloId(paidUntil) {
  if (paidUntil) {
    try {
      const fecha = paidUntil.toDate ? paidUntil.toDate() : new Date(paidUntil);
      if (!isNaN(fecha.getTime())) {
        return `venc-${fecha.toISOString().slice(0, 10)}`;
      }
    } catch (e) { /* cae al respaldo de abajo */ }
  }
  return fechaPY().slice(0, 7);
}

// =====================================================================
// ⭐ LÍMITE DE RESEÑAS MENSUALES (ALEATORIO) — a pedido, para cuando el
// pago mensual de la empresa es bajo y no conviene absorber el costo
// de pedir calificación en CADA turno completado. Configurable desde
// el SuperAdmin (companies/{COMPANY_ID}.maxReviewRequestsPerMonth) —
// null/0 = sin límite, se sigue pidiendo en todos como siempre.
//
// No es "los primeros N del mes" — cada turno elegible tira una
// moneda (40% de probabilidad) antes de chequear el tope, así la
// selección queda repartida a lo largo del mes en vez de agotarse
// apenas empieza. Una vez alcanzado el tope, no se manda más aunque
// la moneda salga a favor.
//
// Contador propio en 'rating_requests_monthly' (mismo patrón de
// ciclo que usage_monthly, pero en su propia colección para no
// mezclar con el cupo de plantillas).
// =====================================================================
let MAX_REVIEWS_CACHE = { value: undefined, cachedAt: 0 };
const MAX_REVIEWS_TTL_MS = 60 * 1000;

async function obtenerMaxReviewsPorMes() {
  const ahora = Date.now();
  if (MAX_REVIEWS_CACHE.value !== undefined && (ahora - MAX_REVIEWS_CACHE.cachedAt) < MAX_REVIEWS_TTL_MS) {
    return MAX_REVIEWS_CACHE.value;
  }
  try {
    const snap = await db.collection('companies').doc(COMPANY_ID).get();
    const data = snap.exists ? snap.data() : {};
    const limite = (typeof data.maxReviewRequestsPerMonth === 'number' && data.maxReviewRequestsPerMonth > 0)
      ? data.maxReviewRequestsPerMonth
      : null;
    MAX_REVIEWS_CACHE = { value: limite, cachedAt: ahora };
    return limite;
  } catch (e) {
    console.error('⚠️ [Capelli] Error obteniendo maxReviewRequestsPerMonth:', e.message);
    return null;
  }
}

// Devuelve true si ESTE turno puntual debe recibir el pedido de
// calificación (respetando el límite mensual configurado, si hay
// uno). Si no hay límite configurado, siempre devuelve true (se
// mantiene el comportamiento de siempre: pedir en todos).
const PROBABILIDAD_SELECCION = 0.4; // 40% de chance por turno elegible, repartido en el mes

async function debeEnviarCalificacionAleatoria() {
  const limite = await obtenerMaxReviewsPorMes();
  if (!limite) return true; // sin límite configurado — comportamiento de siempre

  const paidUntil = await obtenerPaidUntil();
  const cicloId = obtenerCicloId(paidUntil);
  const ref = db.collection('rating_requests_monthly').doc(`${COMPANY_ID}_${cicloId}`);

  try {
    const resultado = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const actual = snap.exists ? (snap.data().count || 0) : 0;

      if (actual >= limite) return false; // tope ya alcanzado este ciclo

      const seleccionado = Math.random() < PROBABILIDAD_SELECCION;
      if (!seleccionado) return false; // no le tocó esta vez

      t.set(ref, { companyId: COMPANY_ID, cicloId, count: actual + 1, limit: limite, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return true;
    });
    return resultado;
  } catch (e) {
    console.error('⚠️ [Capelli] Error chequeando límite de reseñas:', e.message);
    return true; // ante la duda, no cortamos la función — se manda igual
  }
}

// =====================================================================
// 💳 CUPO MENSUAL DE MENSAJES DE CAPELLI
// =====================================================================
const WHATSAPP_MENSUAL_LIMIT = parseInt(process.env.WHATSAPP_MENSUAL_LIMIT || '2000', 10);
const BLOQUEO_ACTIVO = false;

async function puedeEnviar(companyId = COMPANY_ID) {
  const paidUntil = await obtenerPaidUntil();
  const cicloId = obtenerCicloId(paidUntil);
  try {
    const snap = await db.collection('usage_monthly').doc(`monthly_${companyId}_${cicloId}`).get();
    const actual = snap.exists ? (snap.data().count || 0) : 0;
    if (actual >= WHATSAPP_MENSUAL_LIMIT) return { permitido: !BLOQUEO_ACTIVO, motivo: 'limite_mensual_capelli' };
    return { permitido: true, motivo: 'capelli_ok', count: actual, limit: WHATSAPP_MENSUAL_LIMIT };
  } catch (e) {
    console.error('❌ [Capelli] Error en puedeEnviar:', e.message);
    return { permitido: true, motivo: 'error_check' };
  }
}

// categoria: para qué se usó el mensaje — mismo desglose que server.js
// 🆓 "esGratis" lo decide ventanaAbierta() — reemplaza la lista fija de
// categorías, que subestimaba cuánto es gratis en la práctica.
async function consumirCupo(companyId = COMPANY_ID, categoria = 'otro', esGratis = false) {
  const paidUntil = await obtenerPaidUntil();
  const cicloId = obtenerCicloId(paidUntil);
  const ref = db.collection('usage_monthly').doc(`monthly_${companyId}_${cicloId}`);
  try {
    const r = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const actual = snap.exists ? (snap.data().count || 0) : 0;
      const desgloseActual = snap.exists ? (snap.data().desglose || {}) : {};
      const nuevoDesglose = { ...desgloseActual, [categoria]: (desgloseActual[categoria] || 0) + 1 };
      const nuevoCount = esGratis ? actual : actual + 1;
      t.set(ref, {
        companyId,
        plan: 'empresarial',
        mes: fechaPY().slice(0, 7),
        cicloId,
        count: nuevoCount,
        limit: WHATSAPP_MENSUAL_LIMIT,
        desglose: nuevoDesglose,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return { consumido: true, count: nuevoCount };
    });
    console.log(`📊 [Capelli] usa ${r.count}/${WHATSAPP_MENSUAL_LIMIT} msgs en su ciclo actual (${cicloId}). (${categoria}${esGratis ? ' — gratis, no sumó' : ''})`);
    return r;
  } catch (e) {
    console.error('❌ [Capelli] Error en consumirCupo:', e.message);
    return { consumido: false };
  }
}

async function perteneceACapelli({ companyId, locationId, booking } = {}) {
  const comp = String(companyId || booking?.companyId || '').trim();
  const loc  = String(locationId || booking?.locationId || '').trim();
  if (comp === COMPANY_ID) return true;
  if (loc && LOCATION_IDS.includes(loc)) return true;
  if (loc) {
    try {
      const snap = await db.collection('locations').doc(loc).get();
      if (snap.exists && String(snap.data().companyId || '').trim() === COMPANY_ID) return true;
    } catch (e) { console.error('⚠️ [Capelli Router] Error verificando location:', e.message); }
  }
  return false;
}

async function reenviarABarberGo(path, body, res) {
  console.log(`↪️  [Relay] Reenviando a ${BARBERGO_SERVER_URL}${path}`);
  try {
    const r = await fetch(`${BARBERGO_SERVER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json({ ...data, relayedTo: 'barbergo' });
  } catch (e) {
    console.error('❌ [Relay] No se pudo contactar a BarberGo:', e.message);
    return res.status(502).json({ success: false, error: 'No se pudo contactar a BarberGo' });
  }
}

function normalizarNumeroPY(phone) {
  let n = String(phone || '').replace(/\D/g, '');
  if (n.startsWith('0'))         n = '595' + n.substring(1);
  else if (!n.startsWith('595')) n = '595' + n;
  return n;
}

function numeroMetaALocal(numeroMeta) {
  if (String(numeroMeta).startsWith('595')) return '0' + String(numeroMeta).substring(3);
  return String(numeroMeta || '');
}

async function esEmpresarial(reserva) {
  try {
    const companyId = reserva.companyId || COMPANY_ID;
    const companySnap = await db.collection('companies').doc(companyId).get();
    if (companySnap.exists) {
      const plan = companySnap.data().plan || '';
      return plan.toLowerCase() === 'empresarial' || plan.toLowerCase() === 'premium';
    }
  } catch (error) {
    console.error('❌ Error verificando plan:', error);
  }
  return false;
}

async function obtenerDatosUbicacion(locationId) {
  const defaults = { shopName: 'Capelli', mapLink: 'https://maps.app.goo.gl/tu-local', shopUrl: 'https://app.barbergo.com.py' };
  const loc = String(locationId || '').trim();
  if (!loc) return defaults;
  try {
    const snap = await db.collection('locations').doc(loc).get();
    if (snap.exists) {
      const d = snap.data();
      return {
        shopName: (d.name || defaults.shopName).trim(),
        mapLink:  d.mapUrl || defaults.mapLink,
        shopUrl:  d.slug ? `https://app.barbergo.com.py/${d.slug}` : defaults.shopUrl
      };
    }
  } catch (e) { console.error('❌ Error ubicación:', e); }
  return defaults;
}

function formatearReserva(reserva) {
  const dateObj = new Date(reserva.date + 'T00:00:00');
  const formattedDate = dateObj.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
  const clientName   = reserva.client?.name  || 'Cliente';
  const timeStr      = reserva.startTime     || reserva.time || '';
  const barberName   = reserva.barber?.name  || 'Barbero asignado';
  const groupId      = reserva.bookingGroupId || reserva.id || '';
  const tId          = groupId ? String(groupId).slice(-5) : '-----';
  const serviceName  = reserva.services?.length > 0 ? reserva.services.map(s => s.name).join(', ') : 'Servicio de barbería';
  const servicePrice = reserva.totalPrice || '0';
  return { clientName, timeStr, barberName, groupId, tId, serviceName, servicePrice, formattedDate };
}

// =====================================================================
// 📤 ENVIAR TEMPLATE (con categoria para el desglose)
// =====================================================================
async function enviarTemplate(numero, templateName, params = [], companyId = COMPANY_ID, skipLimitCheck = false, esIniciadoPorNegocio = true, categoria = 'otro') {
  if (!skipLimitCheck) {
    const { permitido, motivo } = await puedeEnviar(companyId);
    if (!permitido) { console.log(`🚫 [Capelli] Bloqueado (${motivo})`); return false; }
  }
  try {
    const components = params.length > 0
      ? [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) }]
      : [];
    const body = {
      messaging_product: 'whatsapp', to: numero, type: 'template',
      template: { name: templateName, language: { code: 'es' }, components }
    };
    console.log(`📤 [Capelli] Enviando '${templateName}' a ${numero}...`);
    const resp = await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      console.error(`❌ [Capelli] Error Meta [${templateName}]:`, JSON.stringify(data));
      return false;
    }
    const respData = await resp.json().catch(() => ({}));
    const metaMessageId = respData?.messages?.[0]?.id || null;
    console.log(`✅ [Capelli] Template '${templateName}' enviado a ${numero}`);

    // 📋 Historial de mensajes — para el panel de "Mensajes" de Capelli.
    try {
      await db.collection('message_log').add({
        companyId,
        phone: numero,
        clientName: params[0] ? String(params[0]) : null,
        templateName,
        categoria,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error('⚠️ [Capelli] [Historial mensajes] No se pudo registrar:', e.message);
    }

    // 💬 Mismo envío, ahora en el chat.
    try {
      await db.collection('chat_messages').add({
        companyId, phone: numero, direction: 'outbound',
        templateName, categoria,
        variables: (params || []).slice(0, 8).map(v => String(v)),
        metaMessageId,
        status: 'sent',
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error('⚠️ [Capelli] [Chat] No se pudo registrar mensaje saliente:', e.message);
    }

    const esGratis = await ventanaAbierta(numero, companyId);
    await consumirCupo(companyId, categoria, esGratis);
    if (esIniciadoPorNegocio) await registrarAlcanceMeta(numero);
    return true;
  } catch (error) {
    console.error(`❌ [Capelli] Error enviando '${templateName}':`, error);
    return false;
  }
}

// =====================================================================
// 📊 CONTADOR DE MENSAJES DE SERVICIO (texto libre, no plantilla)
// ---------------------------------------------------------------------
// Hoy estos mensajes son gratis (van dentro de una ventana de servicio
// ya abierta). A partir del 1 de octubre de 2026, Meta empieza a cobrar
// también por estos — así que medimos volumen desde ya para saber el
// impacto real de costo antes de que empiece a facturarse, sin bloquear
// ni cambiar el comportamiento actual. Colección compartida con
// server.js (mismo proyecto de Firebase) — el conteo sale combinado.
// =====================================================================
async function contarMensajeServicio() {
  try {
    const hoy = fechaPY();
    await db.collection('service_text_daily').doc(hoy).set({
      count: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) {
    console.error('⚠️ [Capelli] [Servicio] No se pudo contar mensaje de texto libre:', e.message);
  }
}

// =====================================================================
// 💬 ENVIAR TEXTO LIBRE (interno, no HTTP) — usado cuando el cliente
// ACABA de escribir (confirmar/cancelar/comentario) y por eso ya
// sabemos con certeza que la ventana de servicio de 24hs está abierta.
// A partir del 1° de octubre de 2026, las plantillas dentro de ventana
// empiezan a cobrar exactamente lo mismo que afuera de ventana — pero
// el texto libre sigue teniendo 1.000 mensajes gratis por mes, por
// número (ver el anuncio de Meta). Usar texto libre acá en vez de
// plantilla ahorra ese costo, sin cambiar la esencia de lo que recibe
// el cliente. No toca el "cupo mensual" (consumirCupo/límite del plan)
// — ese sistema es específicamente para plantillas; el texto libre se
// mide aparte con contarMensajeServicio(), para el nuevo tramo de Meta.
// =====================================================================
async function enviarTextoLibreInterno(numero, mensaje, companyId = COMPANY_ID, categoria = 'otro') {
  try {
    const cleanPhone = String(numero).replace(/\D/g, '');
    const payload = {
      messaging_product: 'whatsapp', to: cleanPhone, type: 'text',
      text: { body: String(mensaje).slice(0, 4000) }
    };
    const response = await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('❌ [Capelli] Error Meta [texto libre interno]:', JSON.stringify(errData));
      return false;
    }
    const respData = await response.json().catch(() => ({}));
    const metaMessageId = respData?.messages?.[0]?.id || null;
    console.log(`✅ [Capelli] Texto libre interno enviado a ${cleanPhone}`);

    if (companyId) {
      try {
        await db.collection('message_log').add({
          companyId, phone: cleanPhone, clientName: null,
          templateName: null, textoLibre: true, categoria,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) { console.error('⚠️ [Capelli] [Historial] No se pudo registrar texto libre:', e.message); }

      try {
        await db.collection('chat_messages').add({
          companyId, phone: cleanPhone, direction: 'outbound',
          text: String(mensaje).slice(0, 4000),
          categoria, metaMessageId, status: 'sent',
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) { console.error('⚠️ [Capelli] [Chat] No se pudo registrar texto libre saliente:', e.message); }

      await contarMensajeServicio();
    }
    return true;
  } catch (error) {
    console.error('❌ [Capelli] Error enviando texto libre interno:', error);
    return false;
  }
}

async function enviarRespuestaWhatsApp(reserva, nuevoEstado, numeroMeta, esIniciadoPorNegocio = true) {
  const { shopName, mapLink, shopUrl } = await obtenerDatosUbicacion(reserva.locationId);
  const { clientName, timeStr, barberName, tId, serviceName, servicePrice, formattedDate } = formatearReserva(reserva);

  // 🧪 A pedido: el texto libre (en vez de plantilla) queda atrás del
  // feature flag "pruebaFlujoWhatsapp" — mientras Capelli no lo tenga
  // activado desde SuperAdmin, sigue mandando plantilla como siempre.
  const usarTextoLibre = !esIniciadoPorNegocio && await pruebaFlujoWhatsappActiva();

  // 💬 Si esto es una RESPUESTA a algo que el cliente acaba de
  // escribir Y el flag de prueba está activo, la ventana de 24hs está
  // garantizado abierta en este instante — se manda como TEXTO LIBRE
  // en vez de plantilla, mismo motivo que en server.js (ver
  // comentario de enviarTextoLibreInterno). El texto es nuevo, no pasó
  // por aprobación de Meta — conviene que Joel lo revise antes de
  // activar el flag para más empresas.
  if (usarTextoLibre) {
    let mensaje;
    if (nuevoEstado === 'confirmed') {
      mensaje = `¡Turno Confirmado!\n¡Hola ${clientName}! 💈\n\nConfirmaste tu turno en ${shopName} 🙌\n\n🗓 Fecha: ${formattedDate}\n⏰ Hora: ${timeStr} hs\n👨\u200d🦱 Barbero: ${barberName}\n✂️ Servicio: ${serviceName}\n💰 Precio: Gs ${servicePrice}\n🎫 Ticket: #${tId}\n\n📍 Ubicación: ${mapLink}\n\n¡Te esperamos! 🙌\nPlataforma Gestionada por Barber Go`;
    } else {
      mensaje = `Reserva Cancelada\nHola ${clientName} 👋\n\nTu turno en ${shopName} fue cancelado ❌\n\n🗓 Fecha: ${formattedDate}\n⏰ Hora: ${timeStr}\n👨\u200d🦱 Barbero: ${barberName}\n✂️ Servicio: ${serviceName}\n💰 Precio: Gs ${servicePrice}\n🎫 Ticket: #${tId}\n\nPodés reagendar tu turno cuando quieras 👇\n📲 ${shopUrl}\n\n¡Hasta pronto! 🙌\nPlataforma Gestionada por Barber Go`;
    }
    const enviado = await enviarTextoLibreInterno(numeroMeta, mensaje, COMPANY_ID, 'respuestaCliente');
    if (enviado) return;
    console.log('⚠️ [Capelli] Texto libre falló, usando plantilla de respaldo');
  }

  const templateName = nuevoEstado === 'confirmed' ? TEMPLATES.confirmada : TEMPLATES.cancelada;
  const linkFinal    = nuevoEstado === 'confirmed' ? mapLink : shopUrl;
  const categoria = !esIniciadoPorNegocio
    ? 'respuestaCliente'
    : (nuevoEstado === 'confirmed' ? 'confirmadaDirecta' : 'cancelada');
  await enviarTemplate(numeroMeta, templateName, [clientName, shopName, formattedDate, timeStr, barberName, serviceName, servicePrice, tId, linkFinal], COMPANY_ID, false, esIniciadoPorNegocio, categoria);
}

async function enviarRecordatorioWhatsApp(reserva) {
  const { shopName, mapLink } = await obtenerDatosUbicacion(reserva.locationId);
  const { clientName, timeStr, barberName, tId, serviceName, servicePrice, formattedDate } = formatearReserva(reserva);
  const cleanPhone = normalizarNumeroPY(reserva.client?.phone);
  await enviarTemplate(cleanPhone, TEMPLATES.recordatorio, [clientName, shopName, formattedDate, timeStr, barberName, serviceName, servicePrice, tId, mapLink], COMPANY_ID, false, true, 'recordatorio');
}

async function enviarCalificacionWhatsApp(reserva) {
  const cleanPhone = normalizarNumeroPY(reserva.client?.phone);
  if (!cleanPhone) return;
  const { shopName } = await obtenerDatosUbicacion(reserva.locationId);

  // 🔧 A pedido: la calificación de Capelli NUNCA manda plantilla —
  // solo texto libre, sin excepción y sin importar el flag de prueba.
  // Si la ventana de 24hs está cerrada, directamente no se manda nada
  // (se pierde ese pedido de calificación puntual, mismo criterio de
  // "ahorro máximo" que ya usábamos, ahora sin depender del flag).
  const abierta = await ventanaAbierta(cleanPhone, COMPANY_ID);
  if (!abierta) {
    console.log('⏭️ [Capelli] Calificación omitida — ventana cerrada, nunca se manda plantilla de respaldo');
    return;
  }
  const mensaje = `Califica tu experiencia\n¡Hola ${reserva.client?.name || 'Cliente'}!\n\n💈 ¿Qué te pareció el servicio en ${shopName} con ${reserva.barber?.name || 'tu barbero'}?\n\n⭐ Tu opinión es muy importante para nosotros. Por favor, responde con una calificación del 1️⃣ al 5️⃣:\n\n😞 1️⃣ - Malo\n😐 2️⃣ - Regular\n🙂 3️⃣ - Bueno\n😊 4️⃣ - Muy bueno\n🤩 5️⃣ - Excelente\n\n💬 También puedes dejarnos un comentario sobre tu experiencia (opcional).\n\n🙌 ¡Gracias por ayudarnos a seguir mejorando y brindarte el mejor servicio!\nPlataforma Gestionada por Barber Go`;
  const enviado = await enviarTextoLibreInterno(cleanPhone, mensaje, COMPANY_ID, 'calificacion');
  if (!enviado) console.log('⚠️ [Capelli] Texto libre de calificación falló — nunca se manda plantilla de respaldo');
}

async function enviarAgradecimientoWhatsApp(reserva, telefonoLocal) {
  try {
    const snap = await db.collection('companies').doc(COMPANY_ID).get();
    if (!snap.exists) return;
    const plan = snap.data().plan?.toLowerCase() || '';
    if (plan !== 'empresarial' && plan !== 'premium') return;
  } catch (e) { return; }

  // 🧪 Mismo flag de prueba que enviarRespuestaWhatsApp — mientras no
  // esté activado, cae directo a la plantilla de siempre.
  if (await pruebaFlujoWhatsappActiva()) {
    const mensaje = `Opinión recibida correctamente.\n\nGracias por responder.`;
    const enviado = await enviarTextoLibreInterno(normalizarNumeroPY(telefonoLocal), mensaje, COMPANY_ID, 'agradecimiento');
    if (enviado) return;
    console.log('⚠️ [Capelli] Texto libre de agradecimiento falló, usando plantilla de respaldo');
  }
  await enviarTemplate(normalizarNumeroPY(telefonoLocal), TEMPLATES.agradecimiento, [], COMPANY_ID, false, false, 'agradecimiento');
}

// =====================================================================
// 💾 GUARDAR CALIFICACIÓN — extraído para reusar tanto cuando el
// cliente manda la calificación y el comentario JUNTOS en un solo
// mensaje (ej: "5 excelente el servicio") como cuando los manda en dos
// mensajes separados. Guarda la reseña, actualiza el promedio del
// barbero, y manda el agradecimiento.
// =====================================================================
async function guardarCalificacion(telefonoLocal, stars, comment) {
  const snapshot = await db.collection('bookings')
    .where('client.phone', '==', telefonoLocal)
    .where('locationId', 'in', LOCATION_IDS)
    .where('status', '==', 'completed')
    .orderBy('createdAt', 'desc').limit(3).get();

  const bookingDoc = snapshot.docs.find(d => !d.data().isReviewed);
  if (!bookingDoc) return false;

  const booking    = bookingDoc.data();
  const locationId = booking.locationId ? String(booking.locationId).trim() : null;
  const barberId   = booking.barber?.id  ? String(booking.barber.id).trim()  : null;
  if (!locationId || !barberId) { await bookingDoc.ref.update({ isReviewed: true }); return false; }

  let barberRef = null;
  const directSnap = await db.collection('locations').doc(locationId).collection('barbers').doc(barberId).get();
  if (directSnap.exists) {
    barberRef = directSnap.ref;
  } else {
    for (const idValue of [Number(barberId), barberId]) {
      const q = await db.collection('locations').doc(locationId).collection('barbers').where('id', '==', idValue).limit(1).get();
      if (!q.empty) { barberRef = q.docs[0].ref; break; }
    }
  }
  if (!barberRef) { await bookingDoc.ref.update({ isReviewed: true }); return false; }

  await db.runTransaction(async (t) => {
    const barberDoc = await t.get(barberRef);
    if (!barberDoc.exists) return;
    const curr  = barberDoc.data().rating || 0;
    const count = barberDoc.data().reviewsCount || 0;
    const newCount = count + 1;
    t.update(barberRef, { rating: parseFloat(((curr * count + stars) / newCount).toFixed(1)), reviewsCount: newCount });
    t.update(bookingDoc.ref, { isReviewed: true, reviewStars: stars, reviewComment: comment });
    t.set(barberRef.collection('reviews').doc(bookingDoc.id), {
      clientId: booking.userId || telefonoLocal, clientName: booking.client?.name || 'Cliente',
      stars: Number(stars), comment, createdAt: admin.firestore.FieldValue.serverTimestamp(), bookingId: bookingDoc.id
    });
  });
  await enviarAgradecimientoWhatsApp(booking, telefonoLocal);
  return true;
}

// =====================================================================
// 🧪 AUTOCONFIRMACIÓN DE TURNO INMINENTE — atrás del flag
// pruebaFlujoWhatsapp. Si un turno queda a menos de 60 minutos (y no
// más de 15 en el pasado, por si el cron tarda en pasar), se confirma
// directo, sin pasar por el flujo normal de solicitud + recordatorio +
// espera de respuesta — no tiene sentido pedirle al cliente que
// confirme algo que va a pasar en minutos. Mismo patrón que ya existe
// en el servidor compartido (server.js).
// =====================================================================
async function autoconfirmarReserva(reserva, docIdFallback, origen = 'Auto') {
  const groupId = reserva.bookingGroupId;

  if (groupId) {
    const bloquesSnap = await db.collection('bookings').where('bookingGroupId', '==', groupId).get();
    const yaConfirmado = bloquesSnap.docs.some(d => d.data().confirmedAutomatically);
    if (yaConfirmado) {
      console.log(`⏭️ [Capelli ${origen}] Grupo ${String(groupId).slice(-5)} ya autoconfirmado — ignorando`);
      return false;
    }
    const batch = db.batch();
    bloquesSnap.forEach(d => batch.update(d.ref, {
      status: 'confirmed', reminderSent: true, confirmedAutomatically: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }));
    await batch.commit();
    console.log(`✅ [Capelli ${origen}] ${bloquesSnap.size} bloque(s) confirmado(s)`);
  } else {
    if (reserva.confirmedAutomatically) {
      console.log(`⏭️ [Capelli ${origen}] Ya autoconfirmado — ignorando`);
      return false;
    }
    await db.collection('bookings').doc(docIdFallback).update({
      status: 'confirmed', reminderSent: true, confirmedAutomatically: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  if (reserva.isPrimary !== false) {
    const cleanPhoneAuto = normalizarNumeroPY(reserva.client?.phone);
    const { shopName, mapLink } = await obtenerDatosUbicacion(reserva.locationId);
    const { clientName, timeStr, barberName, tId, serviceName, servicePrice, formattedDate } = formatearReserva(reserva);
    const variables = [clientName, shopName, formattedDate, timeStr, barberName, serviceName, servicePrice, tId, mapLink];
    await enviarTemplate(cleanPhoneAuto, TEMPLATES.confirmada, variables, COMPANY_ID, true, true, 'confirmadaAuto');
    console.log(`📤 [Capelli ${origen}] confirmación enviada a ${cleanPhoneAuto}`);
  }
  return true;
}

// ========================================
// RUTAS
// ========================================
app.get('/', (req, res) => res.status(200).json({ ok: true, message: 'Capelli WhatsApp API activa', role: 'capelli' }));

app.post('/api/enviar-mensaje', async (req, res) => {
  try {
    const { phone, templateName, params = [], locationId, companyId, esReenvioManual } = req.body;
    if (!phone || !templateName) return res.status(400).json({ success: false, error: 'phone y templateName son obligatorios' });

    if ((companyId || locationId) && !(await perteneceACapelli({ companyId, locationId }))) {
      return reenviarABarberGo('/api/enviar-mensaje', req.body, res);
    }

    const cid = companyId || COMPANY_ID;

    const { permitido, motivo } = await puedeEnviar(cid);
    if (!permitido) {
      console.log(`🚫 [Capelli] Bloqueado (${motivo})`);
      return res.status(200).json({ success: false, blocked: motivo, sentBy: 'capelli' });
    }

    const TEMPLATE_MAP = {
      'solicitud_reserva_v3':    TEMPLATES.solicitud,
      'reserva_confirmada_v2':   TEMPLATES.confirmada,
      'reserva_cancelada_v3':    TEMPLATES.cancelada,
      'recordatorio_turno_v3':   TEMPLATES.recordatorio,
      'recordatorio_turno_v4':   TEMPLATES.recordatorio,
      'calificar_barbero_v2':    TEMPLATES.calificacion,
      'agradecimiento_v1':       TEMPLATES.agradecimiento
    };

    const resolvedTemplate = TEMPLATE_MAP[templateName] || templateName;
    const cleanPhone = normalizarNumeroPY(phone);

    let categoria = 'otro';
    if (esReenvioManual) categoria = 'reenvioManual';
    else if (resolvedTemplate === TEMPLATES.solicitud) categoria = 'solicitud';
    else if (resolvedTemplate === TEMPLATES.confirmada) categoria = 'confirmadaDirecta';
    else if (resolvedTemplate === TEMPLATES.cancelada) categoria = 'cancelada';

    const ok = await enviarTemplate(cleanPhone, resolvedTemplate, params, cid, true, true, categoria);
    return res.status(ok ? 200 : 500).json({ success: ok, templateUsed: resolvedTemplate, sentBy: 'capelli' });
  } catch (error) {
    console.error('❌ Error en /api/enviar-mensaje:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 💬 TEXTO LIBRE — para la vista de chat del panel. Solo funciona si el
// cliente escribió en las últimas 24hs (regla de WhatsApp, sin
// excepción). No toca el cupo — un mensaje dentro de la ventana ya es
// gratis por definición.
app.post('/api/enviar-texto-libre', async (req, res) => {
  try {
    const { phone, text, companyId, locationId } = req.body;
    if (!phone || !text || !String(text).trim()) return res.status(400).json({ success: false, error: 'Faltan datos' });

    if ((companyId || locationId) && !(await perteneceACapelli({ companyId, locationId }))) {
      return reenviarABarberGo('/api/enviar-texto-libre', req.body, res);
    }

    const cid = companyId || COMPANY_ID;
    const cleanPhone = normalizarNumeroPY(phone);

    const abierta = await ventanaAbierta(cleanPhone, cid);
    if (!abierta) {
      return res.status(200).json({ success: false, blocked: 'ventana_cerrada', error: 'La ventana de 24hs con este cliente está cerrada — solo se puede responder con plantillas aprobadas.' });
    }

    const payload = {
      messaging_product: 'whatsapp', to: cleanPhone, type: 'text',
      text: { body: String(text).slice(0, 4000) }
    };
    const resp = await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      console.error('❌ [Capelli] Error Meta [texto libre]:', JSON.stringify(data));
      return res.status(200).json({ success: false, error: 'Meta rechazó el mensaje' });
    }
    const respData = await resp.json().catch(() => ({}));
    const metaMessageId = respData?.messages?.[0]?.id || null;
    console.log(`✅ [Capelli] Texto libre enviado a ${cleanPhone}`);

    try {
      await db.collection('chat_messages').add({
        companyId: cid, phone: cleanPhone, direction: 'outbound',
        text: String(text).slice(0, 4000),
        metaMessageId,
        status: 'sent',
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error('⚠️ [Capelli] [Chat] No se pudo registrar texto libre saliente:', e.message);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Error en /api/enviar-texto-libre:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/reserva-completada', async (req, res) => {
  try {
    const { bookingId } = req.body;
    if (!bookingId) return res.status(400).json({ success: false, error: 'Falta bookingId' });

    const bookingRef  = db.collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) return res.status(404).json({ success: false, error: 'Reserva no encontrada' });

    const realBooking = bookingSnap.data();

    if (!(await perteneceACapelli({ booking: realBooking }))) {
      return reenviarABarberGo('/api/reserva-completada', req.body, res);
    }

    if (!realBooking.isPrimary || realBooking.ratingTemplateSent) {
      return res.status(200).json({ success: true, message: 'Ya procesado o no es primario' });
    }

    const empresarial = await esEmpresarial(realBooking);
    if (!empresarial) {
      await bookingRef.update({ ratingTemplateSent: true, isReviewed: false });
      return res.status(200).json({ success: true, message: 'Plan sin calificaciones automáticas' });
    }

    const fechaReserva = realBooking.date;
    const hoyAsuncion  = fechaPY();
    const ayerAsuncion = fechaPY(-1);

    if (fechaReserva !== hoyAsuncion && fechaReserva !== ayerAsuncion) {
      console.log(`⏭️ [Capelli] Reserva del ${fechaReserva} fuera de ventana 24hs — calificación omitida`);
      await bookingRef.update({ ratingTemplateSent: true, isReviewed: false });
      return res.status(200).json({ success: true, message: 'Reserva fuera de ventana de 24hs — calificación omitida' });
    }

    // ⭐ Límite de reseñas mensuales (aleatorio) — si esta empresa tiene
    // configurado un tope (ej: Capelli, 20/mes), este turno puntual
    // puede quedar afuera de la selección aunque cumpla todo lo demás.
    const seleccionadoParaCalificar = await debeEnviarCalificacionAleatoria();
    if (!seleccionadoParaCalificar) {
      console.log(`🎲 [Capelli] Turno no seleccionado para calificación (límite mensual o no le tocó esta vez)`);
      await bookingRef.update({ ratingTemplateSent: true, isReviewed: false });
      return res.status(200).json({ success: true, message: 'No seleccionado para calificación este mes' });
    }

    console.log(`💈 [Capelli] Cuenta EMPRESARIAL. Solicitando calificación con: ${TEMPLATES.calificacion}`);
    await enviarCalificacionWhatsApp(realBooking);
    await bookingRef.update({ ratingTemplateSent: true, isReviewed: false });

    return res.status(200).json({ success: true, message: 'Solicitud de calificación enviada', sentBy: 'capelli' });
  } catch (error) {
    console.error('❌ Error en /api/reserva-completada:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

app.post('/api/admin-notificar-cancelacion', async (req, res) => {
  try {
    const { reserva } = req.body;
    if (!reserva || !reserva.client || !reserva.client.phone)
      return res.status(400).json({ success: false, error: 'Faltan datos' });

    if (!(await perteneceACapelli({ booking: reserva })))
      return reenviarABarberGo('/api/admin-notificar-cancelacion', req.body, res);

    const numeroMeta = normalizarNumeroPY(reserva.client.phone);
    await enviarRespuestaWhatsApp(reserva, 'cancelled', numeroMeta);
    return res.status(200).json({ success: true, message: 'Cancelación enviada', sentBy: 'capelli' });
  } catch (error) {
    console.error('❌ Error en /api/admin-notificar-cancelacion:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        if (value.metadata?.phone_number_id !== PHONE_NUMBER_ID) continue;

        // 📬 ACTUALIZACIONES DE ESTADO (entregado/leído) — pueden venir
        // solas, sin mensajes en el mismo payload, así que se procesan
        // ANTES del "continue" de abajo.
        if (Array.isArray(value.statuses)) {
          for (const estado of value.statuses) {
            try {
              const metaId = estado.id;
              const nuevoStatus = estado.status;
              if (!metaId || !nuevoStatus) continue;
              const snapEstado = await db.collection('chat_messages').where('metaMessageId', '==', metaId).limit(1).get();
              if (!snapEstado.empty) {
                await snapEstado.docs[0].ref.update({ status: nuevoStatus, statusUpdatedAt: admin.firestore.FieldValue.serverTimestamp() });
              }
            } catch (e) {
              console.error('⚠️ [Capelli] Error actualizando estado de mensaje:', e.message);
            }
          }
        }

        if (!value.messages) continue;

        for (const mensaje of value.messages) {
          const numeroMeta    = mensaje.from || '';
          const telefonoLocal = numeroMetaALocal(numeroMeta);

          // Texto CRUDO (para el chat) aparte de la versión en
          // minúsculas que ya usa el bot para reconocer "sí"/"no"/etc.
          let textoCrudo = '';
          if (mensaje.type === 'text')        textoCrudo = mensaje.text?.body || '';
          else if (mensaje.type === 'button') textoCrudo = mensaje.button?.text || '';
          else if (mensaje.type === 'interactive') {
            textoCrudo = mensaje.interactive?.button_reply?.title || mensaje.interactive?.list_reply?.title || '';
          }
          let respuestaCliente = textoCrudo.toLowerCase().trim();

          // 🕐 Se registra ante CUALQUIER mensaje del cliente — abre/
          // renueva su ventana de servicio de 24hs, y queda en el chat.
          await registrarMensajeEntrante(numeroMeta);
          if (textoCrudo) await registrarMensajeChat(numeroMeta, COMPANY_ID, textoCrudo);

          console.log(`📞 [Capelli] Mensaje de: ${numeroMeta} | Texto: "${respuestaCliente}"`);

          // 1. CALIFICACIÓN (1-5) — sola, o junto con el comentario en
          // el mismo mensaje (ej: "5 excelente el servicio"). El \b
          // evita que algo como "5000" se confunda con calificación.
          const ratingComboMatch = respuestaCliente.trim().match(/^([1-5])\b\s*(.*)$/s);
          if (ratingComboMatch) {
            const stars = parseInt(ratingComboMatch[1]);
            const comentarioInline = ratingComboMatch[2].trim();
            if (comentarioInline) {
              await guardarCalificacion(telefonoLocal, stars, comentarioInline);
            } else {
              await db.collection('rating_sessions_capelli').doc(telefonoLocal).set({
                stars, phone: telefonoLocal, companyId: COMPANY_ID,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                // 🔧 A pedido: 10 min era muy poco tiempo real para escribir
                // un comentario — si expiraba antes, ese texto caía en la
                // lógica de confirmar/cancelar y podía disparar el mensaje
                // de confirmación por segunda vez. Ahora son 60 minutos.
                expiresAt: new Date(Date.now() + 60 * 60 * 1000)
              });
            }
            continue;
          }

          // 2. COMENTARIO DE CALIFICACIÓN (cuando el número llegó solo)
          const sessionSnap = await db.collection('rating_sessions_capelli').doc(telefonoLocal).get();
          if (sessionSnap.exists) {
            const session   = sessionSnap.data();
            const expiresAt = session.expiresAt?.toDate ? session.expiresAt.toDate() : new Date(session.expiresAt);
            if (new Date() < expiresAt) {
              const { stars } = session;
              const comment = respuestaCliente.trim();
              await db.collection('rating_sessions_capelli').doc(telefonoLocal).delete();
              await guardarCalificacion(telefonoLocal, stars, comment);
              continue;
            }
            await db.collection('rating_sessions_capelli').doc(telefonoLocal).delete();
          }

          const palabras    = respuestaCliente.split(/[\s,.!?;:()]+/).filter(Boolean);
          const esConfirmar = palabras.some(p => ['si','sí','sii','siii','ok','okey','dale','voy','asisto','perfecto','excelente','seguro'].includes(p)) || respuestaCliente.includes('confirm');
          const esCancelar  = palabras.some(p => ['no','imposible'].includes(p)) || respuestaCliente.includes('cancel') || respuestaCliente.includes('no voy') || respuestaCliente.includes('me complico');

          let nuevoEstado = null;
          if (esCancelar)       nuevoEstado = 'cancelled';
          else if (esConfirmar) nuevoEstado = 'confirmed';
          if (!nuevoEstado) continue;

          const estadosValidos = nuevoEstado === 'confirmed' ? ['pending'] : ['pending', 'confirmed'];
          const snap = await db.collection('bookings')
            .where('client.phone', '==', telefonoLocal)
            .where('locationId', 'in', LOCATION_IDS)
            .where('status', 'in', estadosValidos)
            .orderBy('createdAt', 'desc').limit(1).get();

          if (snap.empty) continue;

          const reservaDoc = snap.docs[0];
          const reserva    = reservaDoc.data();
          if (nuevoEstado === 'confirmed' && reserva.status === 'confirmed') continue;

          const groupId = reserva.bookingGroupId;
          if (!groupId) {
            await db.collection('bookings').doc(reservaDoc.id).update({ status: nuevoEstado, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          } else {
            const bloquesSnap = await db.collection('bookings').where('bookingGroupId', '==', groupId).get();
            const batch = db.batch();
            bloquesSnap.forEach(d => batch.update(d.ref, { status: nuevoEstado, updatedAt: admin.firestore.FieldValue.serverTimestamp() }));
            await batch.commit();
          }
          await enviarRespuestaWhatsApp(reserva, nuevoEstado, numeroMeta, false);
        }
      }
    }
  } catch (error) {
    console.error('❌ [Capelli] Error webhook:', error);
  }
});

cron.schedule('*/15 * * * *', async () => {
  try {
    const py = horaParaguay();
    const todayStr = py.dateStr;

    // 🧪 A pedido: respaldo del listener en tiempo real (más abajo) —
    // si por algún motivo el listener no llegó a autoconfirmar un
    // turno inminente (ej: el server se reinició justo en ese
    // momento), este chequeo cada 15 min lo agarra igual. Solo corre
    // si el flag de prueba está activo para Capelli.
    if (await pruebaFlujoWhatsappActiva()) {
      try {
        const pendientesSnap = await db.collection('bookings')
          .where('date', '==', todayStr)
          .where('locationId', 'in', LOCATION_IDS)
          .where('status', 'in', ['pending', 'confirmed'])
          .where('isPrimary', '==', true)
          .get();

        for (const doc of pendientesSnap.docs) {
          const reserva = doc.data();
          if (reserva.confirmedAutomatically) continue;
          const timeStr = reserva.startTime || reserva.time;
          if (!timeStr) continue;
          const diff = minutosHastaTurno(timeStr, py);
          if (diff !== null && diff >= -15 && diff < 60) {
            console.log(`⚡ [Capelli Cron] Turno en ${diff} min — autoconfirmando (respaldo)`);
            await autoconfirmarReserva(reserva, doc.id, 'Cron');
          }
        }
      } catch (eImin) {
        console.error('❌ [Capelli Cron] Error en respaldo de turnos inminentes:', eImin.message);
      }
    }

    // 🔧 A pedido — Capelli tiene un esquema propio de recordatorio:
    // - Si el cliente reservó el MISMO día del turno → recordatorio 3hs
    //   antes (165-195 min)
    // - Si reservó con anticipación (ej: lunes para el sábado) →
    //   recordatorio 6hs antes (345-375 min)
    // La distinción es por CUÁNDO SE HIZO LA RESERVA vs. la fecha del
    // turno — no por si el turno cae hoy o mañana en el momento en que
    // corre el cron (6hs antes de un turno casi siempre cae el MISMO
    // día del turno, no el día anterior, así que revisar por fecha del
    // turno no funcionaría bien acá).
    // Se revisa un rango de hasta 7 días para adelante, para cubrir
    // reservas hechas con bastante anticipación sin tener que barrer
    // toda la colección.
    const fechaLimite = fechaPY(7);
    const snapshot = await db.collection('bookings')
      .where('date', '>=', todayStr)
      .where('date', '<=', fechaLimite)
      .where('locationId', 'in', LOCATION_IDS)
      .where('status', '==', 'confirmed')
      .where('reminderSent', '==', false).get();

    for (const doc of snapshot.docs) {
      try {
        const reserva = doc.data();
        const timeStr = reserva.startTime || reserva.time;
        if (!timeStr || !reserva.date) continue;

        const diffMinutes = minutosHastaTurnoCompleto(reserva.date, timeStr);
        if (diffMinutes === null) continue;

        // ¿Se reservó el mismo día del turno, o con anticipación?
        // Comparamos la fecha del turno contra la fecha de creación de
        // la reserva, convertida a hora de Paraguay.
        let esReservaMismoDia = false;
        let fechaCreacion = null;
        if (reserva.createdAt?.toDate) fechaCreacion = reserva.createdAt.toDate();
        else if (reserva.createdAt?.seconds) fechaCreacion = new Date(reserva.createdAt.seconds * 1000);
        if (fechaCreacion) {
          const dPY = new Date(fechaCreacion.getTime() + PY_OFFSET_MIN * 60 * 1000);
          const fechaCreacionPY = `${dPY.getUTCFullYear()}-${String(dPY.getUTCMonth() + 1).padStart(2, '0')}-${String(dPY.getUTCDate()).padStart(2, '0')}`;
          esReservaMismoDia = fechaCreacionPY === reserva.date;
        }

        const ventana = esReservaMismoDia ? { min: 165, max: 195 } : { min: 345, max: 375 };

        if (diffMinutes >= ventana.min && diffMinutes <= ventana.max) {
          await db.collection('bookings').doc(doc.id).update({ reminderSent: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          await enviarRecordatorioWhatsApp(reserva);
        }
      } catch (eDoc) {
        console.error(`❌ [Capelli CRON] Error procesando reserva ${doc.id}:`, eDoc.message);
      }
    }
  } catch (error) {
    console.error('❌ [Capelli CRON] Error:', error);
  }
});

app.post('/api/notificar-reserva', async (req, res) => {
  const { tokens, title, body, data } = req.body;
  if (!tokens || tokens.length === 0) return res.status(400).json({ error: 'Sin tokens' });
  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: title || '¡Nueva Reserva! 💈', body: body || 'Nuevo turno agendado' },
      data: {
        title: title || '¡Nueva Reserva! 💈',
        body: body || 'Nuevo turno agendado',
        bookingId: data?.bookingId || '',
        locationId: data?.locationId || ''
      },
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: 'barbergo_reservas', tag: data?.bookingId || 'nueva-reserva' }
      },
      webpush: {
        headers: { Urgency: 'high' },
        notification: { tag: data?.bookingId || 'nueva-reserva', renotify: false }
      }
    });
    res.json({ success: true, enviados: response.successCount });
  } catch (error) {
    console.error('❌ Error FCM Capelli:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Capelli WhatsApp API activa en puerto ${PORT}`);
  console.log(`🚦 Relay configurado hacia BarberGo: ${BARBERGO_SERVER_URL}`);
  console.log(`💳 Cupo mensual WhatsApp: ${WHATSAPP_MENSUAL_LIMIT} msgs/mes`);
  console.log(`📡 Alcance compartido con el bot de BarberGo vía meta_reach_daily (mismo Business Portfolio)`);
});

// =====================================================================
// 🧪 LISTENER EN TIEMPO REAL — turno inminente, atrás del flag
// pruebaFlujoWhatsapp. El cron de arriba corre cada 15 minutos, que
// puede ser demasiado tarde para un turno que se crea con, por
// ejemplo, 10 minutos de anticipación — para cuando el cron pasa, el
// turno ya sucedió. Este listener reacciona al instante apenas se crea
// la reserva. Mismo patrón que ya usa el servidor compartido
// (server.js).
// =====================================================================
let capelliListenerReady = false;
setTimeout(() => {
  db.collection('bookings')
    .where('locationId', 'in', LOCATION_IDS)
    .where('status', 'in', ['pending', 'confirmed'])
    .onSnapshot(async (snapshot) => {
      if (!capelliListenerReady) { capelliListenerReady = true; console.log('👂 [Capelli] Escuchador de turnos inminentes activo'); return; }
      for (const change of snapshot.docChanges()) {
        if (change.type !== 'added') continue;
        const booking = change.doc.data();
        if (!booking.isPrimary || booking.confirmedAutomatically) continue;

        let bookingCreatedAt = 0;
        if (booking.createdAt?.toMillis) bookingCreatedAt = booking.createdAt.toMillis();
        else if (booking.createdAt?.seconds) bookingCreatedAt = booking.createdAt.seconds * 1000;
        if (bookingCreatedAt > 0 && Date.now() - bookingCreatedAt > 300000) continue; // solo reservas recién creadas

        try {
          if (!(await pruebaFlujoWhatsappActiva())) continue;
          const py = horaParaguay();
          if (booking.date !== py.dateStr) continue;
          const timeStr = booking.startTime || booking.time || '';
          if (!timeStr) continue;
          const diff = minutosHastaTurno(timeStr, py);
          console.log(`🔍 [Capelli Listener] fecha: ${booking.date} | hora: ${timeStr} | diff: ${diff} min`);
          if (diff !== null && diff >= -15 && diff < 60) {
            console.log(`⚡ [Capelli Listener] Turno en ${diff} min — autoconfirmando`);
            await autoconfirmarReserva(booking, change.doc.id, 'Listener');
          }
        } catch (eAuto) {
          console.error('❌ [Capelli Listener] Error en autoconfirmación:', eAuto.message);
        }
      }
    });
}, 3000);