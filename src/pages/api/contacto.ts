import type { APIRoute } from "astro";
import nodemailer from "nodemailer";

// Esta ruta corre en el servidor (Vercel), no se genera estática
export const prerender = false;

const AREAS: Record<string, string> = {
  penal: "Derecho Penal",
  familia: "Derecho de Familia",
  constitucional: "Derecho Constitucional",
  civil: "Derecho Civil",
  administrativo: "Derecho Administrativo",
  corporativo: "Derecho Corporativo",
};

const MAX = { nombre: 120, email: 160, telefono: 20, mensaje: 3000 };
const MIN_FILL_MS = 3000; // un humano tarda más que esto en llenar el formulario

// Límite simple por IP (en memoria: es un freno básico, no una barrera absoluta)
const hits = new Map<string, number[]>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 5;

const env = (key: string): string | undefined =>
  process.env[key] ?? (import.meta.env as Record<string, string | undefined>)[key];

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const clean = (v: FormDataEntryValue | null) => (typeof v === "string" ? v.trim() : "");

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let data: FormData;
  try {
    data = await request.formData();
  } catch {
    return json({ ok: false, error: "Solicitud no válida." }, 400);
  }

  // Honeypot: si el campo oculto viene lleno, es un bot. Respondemos "ok" sin enviar nada.
  if (clean(data.get("website"))) return json({ ok: true });

  const startedAt = Number(clean(data.get("t")));
  if (!startedAt || Date.now() - startedAt < MIN_FILL_MS) {
    return json({ ok: false, error: "Por favor, vuelva a intentarlo." }, 400);
  }

  const ip = clientAddress || request.headers.get("x-forwarded-for") || "unknown";
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_HITS) {
    return json({ ok: false, error: "Demasiados intentos. Intente nuevamente en unos minutos." }, 429);
  }
  recent.push(now);
  hits.set(ip, recent);

  const nombre = clean(data.get("nombre"));
  const email = clean(data.get("email"));
  const telefono = clean(data.get("telefono"));
  const area = clean(data.get("area"));
  const mensaje = clean(data.get("mensaje"));
  const consentimiento = clean(data.get("consentimiento"));

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
  const phoneOk = /^\+?[0-9\s-]{7,20}$/.test(telefono);

  if (
    !nombre || nombre.length > MAX.nombre ||
    !emailOk || email.length > MAX.email ||
    !phoneOk || telefono.length > MAX.telefono ||
    !AREAS[area] ||
    mensaje.length < 10 || mensaje.length > MAX.mensaje
  ) {
    return json({ ok: false, error: "Revise los datos ingresados e intente nuevamente." }, 400);
  }

  if (consentimiento !== "on") {
    return json({ ok: false, error: "Debe aceptar la Política de Privacidad para enviar su consulta." }, 400);
  }

  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  const to = env("CONTACT_TO");
  if (!user || !pass || !to) {
    console.error("Faltan variables de entorno: SMTP_USER, SMTP_PASS o CONTACT_TO");
    return json({ ok: false, error: "El servicio de contacto no está disponible por el momento." }, 500);
  }

  const areaLabel = AREAS[area];
  const text = [
    "Nueva consulta desde el sitio web",
    "",
    `Nombre: ${nombre}`,
    `Correo: ${email}`,
    `Teléfono: ${telefono}`,
    `Área de interés: ${areaLabel}`,
    "",
    "Mensaje:",
    mensaje,
    "",
    "El usuario aceptó la Política de Privacidad.",
  ].join("\n");

  const html = `
    <h2 style="font-family:Georgia,serif;margin:0 0 16px">Nueva consulta desde el sitio web</h2>
    <table style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0"><b>Nombre</b></td><td>${escapeHtml(nombre)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0"><b>Correo</b></td><td>${escapeHtml(email)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0"><b>Teléfono</b></td><td>${escapeHtml(telefono)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0"><b>Área</b></td><td>${escapeHtml(areaLabel)}</td></tr>
    </table>
    <p style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap;margin-top:16px">${escapeHtml(mensaje)}</p>
    <p style="font-family:Arial,sans-serif;font-size:12px;color:#777">El usuario aceptó la Política de Privacidad.</p>`;

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });

    await transporter.sendMail({
      from: `"Web Arias & Zereceda" <${user}>`,
      to,
      replyTo: `"${nombre.replace(/["\r\n]/g, "")}" <${email}>`,
      subject: `Nueva consulta web: ${areaLabel} (${nombre.replace(/[\r\n]/g, " ")})`,
      text,
      html,
    });

    return json({ ok: true });
  } catch (error) {
    console.error("Error al enviar el correo de contacto:", error);
    return json({ ok: false, error: "No pudimos enviar su consulta. Intente nuevamente o escríbanos por WhatsApp." }, 502);
  }
};
