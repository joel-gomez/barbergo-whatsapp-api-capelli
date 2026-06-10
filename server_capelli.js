const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');
const cron    = require('node-cron');

// ========================================
// FIREBASE ADMIN
// ========================================
const serviceAccount = require('/etc/secrets/firebase-key.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db  = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

// ========================================
// VARIABLES DE ENTORNO (Capelli)
// ========================================
const WHATSAPP_TOKEN   = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN;
const PORT             = process.env.PORT || 10000;

const COMPANY_ID = 'nI6ilcu8qPbH3xiXXsM7'; // Capelli — hardcodeado, nunca cambia

// ========================================
// HELPERS DE TELÉFONO
// ========================================
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

// ========================================
// HELPER: DATOS DE UBICACIÓN
// ========================================
async function obtenerDatosUbicacion(locationId) {
  const defaults = {
    shopName: 'Capelli',
    mapLink:  'https://maps.app.goo.gl/tu-local',
    shopUrl:  'https://app.barbergo.com.py'
  };
  if (!locationId) return defaults;
  try {
    const snap = await db.collection('locations').doc(locationId).get();
    if (snap.exists) {
      const d = snap.data();
      return {
        shopName: (d.name || defaults.shopName).trim(),
        mapLink:  d.mapUrl || defaults.mapLink,
        shopUrl:  d.slug ? `https://app.barbergo.com.py/${d.slug}` : defaults.shopUrl
      };
    }
  } catch (e) {
    console.error('❌ Error obteniendo datos de ubicación:', e);
  }
  return defaults;
}

// ========================================
// HELPER: FORMATEAR DATOS DE RESERVA
// ========================================
function formatearReserva(reserva) {
  const dateObj = new Date(reserva.date + 'T00:00:00');
  const formattedDate = dateObj
    .toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })
    .replace(',', '');

  const clientName   = reserva.client?.name  || 'Cliente';
  const timeStr      = reserva.startTime     || reserva.time || '';
  const barberName   = reserva.barber?.name  || 'Barbero asignado';
  const groupId      = reserva.bookingGroupId || reserva.id || '';
  const tId          = groupId ? String(groupId).slice(-5) : '-----';
  const serviceName  = reserva.services?.length > 0
    ? reserva.services.map(s => s.name).join(', ')
    : 'Servicio de barbería';
  const servicePrice = reserva.totalPrice || '0';

  return { clientName, timeStr, barberName, groupId, tId, serviceName, servicePrice, formattedDate };
}

// ========================================
// WHATSAPP: ENVIAR TEMPLATE
// ========================================
async function enviarTemplate(to, templateName, variables = []) {
  const cleanPhone = String(to).replace(/\D/g, '');

  const payload = {
    messaging_product: 'whatsapp',
    to: cleanPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'es' },
      ...(variables.length > 0 && {
        components: [{
          type: 'body',
          parameters: variables.map(v => ({ type: 'text', text: String(v) }))
        }]
      })
    }
  };

  const response = await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const err = await response.json();
    console.error(`❌ Error de Meta [${templateName}]:`, err);
    return false;
  }

  console.log(`✅ Template '${templateName}' enviado a ${cleanPhone}`);
  return true;
}

// ========================================
// WHATSAPP: MENSAJES DE NEGOCIO
// ========================================
async function enviarRespuestaWhatsApp(reserva, nuevoEstado, numeroMeta) {
  const { shopName, mapLink, shopUrl } = await obtenerDatosUbicacion(reserva.locationId);
  const { clientName, timeStr, barberName, tId, serviceName, servicePrice, formattedDate } = formatearReserva(reserva);

  const templateName = nuevoEstado === 'confirmed' ? 'reserva_confirmada_v2' : 'reserva_cancelada_v3';
  const linkFinal    = nuevoEstado === 'confirmed' ? mapLink : shopUrl;

  await enviarTemplate(numeroMeta, templateName, [
    clientName, shopName, formattedDate, timeStr,
    barberName, serviceName, servicePrice, tId, linkFinal
  ]);
}

async function enviarRecordatorioWhatsApp(reserva) {
  const { shopName, mapLink } = await obtenerDatosUbicacion(reserva.locationId);
  const { clientName, timeStr, barberName, tId, serviceName, servicePrice, formattedDate } = formatearReserva(reserva);
  const cleanPhone = normalizarNumeroPY(reserva.client?.phone);

  await enviarTemplate(cleanPhone, 'recordatorio_turno_v4', [
    clientName, shopName, formattedDate, timeStr,
    barberName, serviceName, servicePrice, tId, mapLink
  ]);
}

async function enviarCalificacionWhatsApp(reserva) {
  const cleanPhone = normalizarNumeroPY(reserva.client?.phone);
  if (!cleanPhone) return;

  const { shopName } = await obtenerDatosUbicacion(reserva.locationId);
  const clientName   = reserva.client?.name || 'Cliente';
  const barberName   = reserva.barber?.name || 'tu barbero';

  await enviarTemplate(cleanPhone, 'calificar_barbero_v2', [clientName, shopName, barberName]);
}

async function enviarAgradecimientoWhatsApp(reserva, telefonoLocal) {
  try {
    const snap = await db.collection('companies').doc(COMPANY_ID).get();
    if (!snap.exists || snap.data().plan?.toLowerCase() !== 'premium') {
      console.log('⚠️ Agradecimiento no enviado — Capelli no es Premium.');
      return;
    }
  } catch (e) {
    console.error('❌ Error verificando plan:', e);
    return;
  }

  const cleanPhone = normalizarNumeroPY(telefonoLocal);
  await enviarTemplate(cleanPhone, 'agradecimiento_v1', []);
}

// ========================================
// RUTA DE PRUEBA
// ========================================
app.get('/', (req, res) => {
  res.status(200).json({ ok: true, message: 'Capelli WhatsApp API activa' });
});

// ========================================
// ENVIAR MENSAJE (llamado desde servidor principal)
// ========================================
app.post('/api/enviar-mensaje', async (req, res) => {
  try {
    const { phone, templateName, params = [] } = req.body;

    if (!phone || !templateName) {
      return res.status(400).json({ success: false, error: 'phone y templateName son obligatorios' });
    }

    const cleanPhone = normalizarNumeroPY(phone);
    const ok = await enviarTemplate(cleanPhone, templateName, params);

    return res.status(ok ? 200 : 500).json({ success: ok });
  } catch (error) {
    console.error('❌ Error en /api/enviar-mensaje:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// NOTIFICAR CANCELACIÓN DESDE PANEL ADMIN
// ========================================
app.post('/api/admin-notificar-cancelacion', async (req, res) => {
  try {
    const { reserva } = req.body;

    if (!reserva?.client?.phone) {
      return res.status(400).json({ success: false, error: 'Faltan datos de la reserva o del cliente' });
    }

    const numeroMeta = normalizarNumeroPY(reserva.client.phone);
    await enviarRespuestaWhatsApp(reserva, 'cancelled', numeroMeta);
    return res.status(200).json({ success: true, message: 'Mensaje de cancelación enviado' });

  } catch (error) {
    console.error('❌ Error en /api/admin-notificar-cancelacion:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// RESERVA COMPLETADA → CALIFICACIÓN
// ========================================
app.post('/api/reserva-completada', async (req, res) => {
  try {
    const { reserva, bookingId } = req.body;

    if (!reserva || !bookingId) {
      return res.status(400).json({ success: false, error: 'Faltan reserva o bookingId' });
    }

    if (!reserva.isPrimary) {
      return res.status(200).json({ success: true, message: 'No es reserva primaria, ignorado' });
    }

    if (reserva.ratingTemplateSent) {
      return res.status(200).json({ success: true, message: 'Rating ya enviado previamente' });
    }

    const bookingRef = db.collection('bookings').doc(bookingId);

    let premium = false;
    try {
      const compSnap = await db.collection('companies').doc(COMPANY_ID).get();
      if (compSnap.exists) {
        premium = compSnap.data().plan?.toLowerCase() === 'premium';
      }
    } catch (e) {
      console.error('❌ Error verificando plan:', e);
    }

    if (!premium) {
      console.log(`⚠️ Capelli no es Premium — no se envía calificación.`);
      await bookingRef.update({ ratingTemplateSent: true, isReviewed: false });
      return res.status(200).json({ success: true, message: 'No es cuenta Premium' });
    }

    console.log(`💈 Capelli PREMIUM — enviando solicitud de calificación...`);
    await enviarCalificacionWhatsApp(reserva);
    await bookingRef.update({ ratingTemplateSent: true, isReviewed: false });

    return res.status(200).json({ success: true, message: 'Calificación enviada' });
  } catch (error) {
    console.error('❌ Error en /api/reserva-completada:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// WEBHOOK META (GET — verificación)
// ========================================
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook de Capelli verificado');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ========================================
// WEBHOOK META (POST — mensajes entrantes)
// ========================================
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        if (!value.messages || !Array.isArray(value.messages)) continue;

        for (const mensaje of value.messages) {
          const numeroMeta    = mensaje.from || '';
          const telefonoLocal = numeroMetaALocal(numeroMeta);
          const tipo          = mensaje.type || '';
          let respuestaCliente = '';

          if (tipo === 'text') {
            respuestaCliente = mensaje.text?.body?.toLowerCase()?.trim() || '';
          } else if (tipo === 'button') {
            respuestaCliente = mensaje.button?.text?.toLowerCase()?.trim() || '';
          } else if (tipo === 'interactive') {
            respuestaCliente =
              mensaje.interactive?.button_reply?.title?.toLowerCase()?.trim() ||
              mensaje.interactive?.list_reply?.title?.toLowerCase()?.trim() || '';
          }

          console.log(`📞 [Capelli] De: ${numeroMeta} | Texto: "${respuestaCliente}"`);

          // ── CALIFICACIÓN: número 1-5 ────────────────────────────────────
          const ratingMatch = respuestaCliente.trim().match(/^[1-5]$/);
          if (ratingMatch) {
            const stars = parseInt(ratingMatch[0]);
            console.log(`⭐ Calificación ${stars}★ de ${telefonoLocal}`);
            await db.collection('rating_sessions').doc(telefonoLocal).set({
              stars,
              phone:     telefonoLocal,
              companyId: COMPANY_ID,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              expiresAt: new Date(Date.now() + 10 * 60 * 1000)
            });
            continue;
          }

          // ── CALIFICACIÓN: comentario tras número ─────────────────────────
          const sessionSnap = await db.collection('rating_sessions').doc(telefonoLocal).get();
          if (sessionSnap.exists) {
            const session   = sessionSnap.data();
            const now       = new Date();
            const expiresAt = session.expiresAt?.toDate
              ? session.expiresAt.toDate()
              : new Date(session.expiresAt);

            if (now < expiresAt) {
              const stars   = session.stars;
              const comment = respuestaCliente.trim();
              console.log(`💬 [Capelli] Comentario de ${telefonoLocal}: "${comment}" (${stars}★)`);

              await db.collection('rating_sessions').doc(telefonoLocal).delete();

              const snapshot = await db.collection('bookings')
                .where('client.phone', '==', telefonoLocal)
                .where('companyId', '==', COMPANY_ID)
                .where('status', '==', 'completed')
                .orderBy('createdAt', 'desc')
                .limit(3)
                .get();

              const bookingDoc = snapshot.docs.find(d => d.data().isReviewed !== true);
              if (!bookingDoc) {
                console.log(`⚠️ No hay reservas sin reseñar para ${telefonoLocal}`);
                continue;
              }

              const booking    = bookingDoc.data();
              const locationId = booking.locationId ? String(booking.locationId).trim() : null;
              const barberId   = booking.barber?.id  ? String(booking.barber.id).trim()  : null;

              if (!locationId || !barberId) {
                await bookingDoc.ref.update({ isReviewed: true, reviewComment: 'Error: Faltan datos' });
                continue;
              }

              let barberRef = null;
              const directSnap = await db
                .collection('locations').doc(locationId)
                .collection('barbers').doc(barberId).get();

              if (directSnap.exists) {
                barberRef = directSnap.ref;
              } else {
                for (const idValue of [Number(barberId), barberId]) {
                  const q = await db
                    .collection('locations').doc(locationId)
                    .collection('barbers')
                    .where('id', '==', idValue).limit(1).get();
                  if (!q.empty) { barberRef = q.docs[0].ref; break; }
                }
              }

              if (!barberRef) {
                await bookingDoc.ref.update({ isReviewed: true, reviewComment: 'Error: Barbero no encontrado' });
                continue;
              }

              let ratingGuardado = false;
              await db.runTransaction(async (t) => {
                const barberDoc = await t.get(barberRef);
                if (!barberDoc.exists) {
                  t.update(bookingDoc.ref, { isReviewed: true });
                  return;
                }
                const curr  = barberDoc.data().rating       || 0;
                const count = barberDoc.data().reviewsCount || 0;
                const newCount  = count + 1;
                const newRating = ((curr * count) + stars) / newCount;

                t.update(barberRef, {
                  rating:       parseFloat(newRating.toFixed(1)),
                  reviewsCount: newCount
                });
                t.update(bookingDoc.ref, {
                  isReviewed:    true,
                  reviewStars:   stars,
                  reviewComment: comment
                });
                t.set(barberRef.collection('reviews').doc(bookingDoc.id), {
                  clientId:   booking.userId || booking.client?.phone || 'whatsapp-user',
                  clientName: booking.client?.name || 'Cliente de WhatsApp',
                  stars:      Number(stars),
                  comment,
                  createdAt:  admin.firestore.FieldValue.serverTimestamp(),
                  bookingId:  bookingDoc.id
                });
                ratingGuardado = true;
              });

              if (ratingGuardado) {
                console.log(`✅ [Capelli] Calificación ${stars}★ guardada para ${booking.barber?.name}`);
                await enviarAgradecimientoWhatsApp(booking, telefonoLocal);
              }
              continue;
            } else {
              await db.collection('rating_sessions').doc(telefonoLocal).delete();
              console.log(`⏰ Sesión de calificación expirada para ${telefonoLocal}`);
            }
          }

          // ── CONFIRMACIÓN / CANCELACIÓN ───────────────────────────────────
          const palabras = respuestaCliente.split(/[\s,.!?;:()]+/).filter(Boolean);
          const exactasConfirmar = ['si', 'sí', 'sii', 'siii', 'ok', 'okey', 'dale', 'voy', 'asisto', 'perfecto', 'excelente', 'seguro'];
          const exactasCancelar  = ['no', 'imposible'];

          const esConfirmar =
            palabras.some(p => exactasConfirmar.includes(p)) ||
            respuestaCliente.includes('confirm') ||
            respuestaCliente.includes('de una')  ||
            respuestaCliente === '✅ confirmar';

          const esCancelar =
            palabras.some(p => exactasCancelar.includes(p)) ||
            respuestaCliente.includes('cancel')     ||
            respuestaCliente.includes('anul')       ||
            respuestaCliente.includes('no voy')     ||
            respuestaCliente.includes('no podre')   ||
            respuestaCliente.includes('no podré')   ||
            respuestaCliente.includes('me complico') ||
            respuestaCliente === '❌ cancelar turno';

          let nuevoEstado = null;
          if (esCancelar)       nuevoEstado = 'cancelled';
          else if (esConfirmar) nuevoEstado = 'confirmed';

          if (!nuevoEstado) {
            console.log('ℹ️ [Capelli] Mensaje no reconocido, ignorado.');
            continue;
          }

          console.log(`🔄 [Capelli] Cliente quiere: ${nuevoEstado}`);

          try {
            const estadosValidos = nuevoEstado === 'confirmed' ? ['pending'] : ['pending', 'confirmed'];
            const snap = await db.collection('bookings')
              .where('client.phone', '==', telefonoLocal)
              .where('companyId', '==', COMPANY_ID)
              .where('status', 'in', estadosValidos)
              .orderBy('createdAt', 'desc')
              .limit(1)
              .get();

            if (snap.empty) {
              console.log(`⚠️ [Capelli] No hay reservas válidas para ${telefonoLocal}`);
              continue;
            }

            const reservaDoc = snap.docs[0];
            const reserva    = reservaDoc.data();
            const groupId    = reserva.bookingGroupId;

            if (nuevoEstado === 'confirmed' && reserva.status === 'confirmed') {
              console.log('ℹ️ Ya estaba confirmado, ignorado.');
              continue;
            }

            if (!groupId) {
              await db.collection('bookings').doc(reservaDoc.id).update({
                status: nuevoEstado,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              });
            } else {
              const bloquesSnap = await db.collection('bookings')
                .where('bookingGroupId', '==', groupId).get();
              const batch = db.batch();
              bloquesSnap.forEach(d => {
                batch.update(d.ref, {
                  status: nuevoEstado,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
              });
              await batch.commit();
            }

            console.log(`✅ [Capelli] Grupo ${groupId} → '${nuevoEstado}'`);
            await enviarRespuestaWhatsApp(reserva, nuevoEstado, numeroMeta);

          } catch (dbError) {
            console.error('❌ [Capelli] Error en Firestore:', dbError);
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ [Capelli] Error procesando webhook:', error);
  }
});

// ========================================
// CRON: RECORDATORIOS 2 HORAS ANTES
// ========================================
cron.schedule('*/15 * * * *', async () => {
  console.log('⏳ [Capelli CRON] Revisando recordatorios...');
  try {
    const now      = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Asuncion' }));
    const todayStr = now.toISOString().split('T')[0];

    const snapshot = await db.collection('bookings')
      .where('date', '==', todayStr)
      .where('companyId', '==', COMPANY_ID)
      .where('status', '==', 'confirmed')
      .where('reminderSent', '==', false)
      .get();

    if (snapshot.empty) return;

    for (const doc of snapshot.docs) {
      const reserva = doc.data();
      const timeStr = reserva.startTime || reserva.time;
      if (!timeStr) continue;

      const [h, m] = timeStr.split(':').map(Number);
      const bookingTime = new Date(now);
      bookingTime.setHours(h, m, 0, 0);
      const diffMinutes = Math.floor((bookingTime - now) / 60000);

      // Ventana: entre 105 y 135 minutos antes (2hs ± 15min por el intervalo del cron)
      if (diffMinutes >= 105 && diffMinutes <= 135) {
        console.log(`🎯 [Capelli] Recordatorio 2hs → ${reserva.client?.name} (${timeStr})`);
        await db.collection('bookings').doc(doc.id).update({
          reminderSent: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await enviarRecordatorioWhatsApp(reserva);
      }
    }
  } catch (error) {
    console.error('❌ [Capelli CRON] Error:', error);
  }
});

// ========================================
// INICIAR SERVIDOR
// ========================================
app.listen(PORT, () => {
  console.log(`🚀 Capelli WhatsApp API activa en puerto ${PORT}`);
  console.log(`🌐 Webhook: /webhook`);
  console.log(`💈 Reserva completada: /api/reserva-completada`);
});