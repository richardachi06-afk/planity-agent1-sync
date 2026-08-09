import { z } from "zod";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must use YYYY-MM-DD");
const timeSchema = z
  .string()
  .regex(/^\d{2}:\d{2}$/, "preferred_time must use HH:mm");

export const availabilityArgsSchema = z
  .object({
    // Retell Audio serializes optional tool arguments as null in some calls.
    // Treat null exactly like an omitted field so a harmless optional value
    // cannot abort the whole availability check.
    services: z.array(z.string().min(2)).min(1).max(4).nullish(),
    service: z.string().min(2).nullish(),
    leistung: z.string().min(2).nullish(),
    date: dateSchema.nullish(),
    preferred_date: dateSchema.nullish(),
    staff: z.string().min(2).nullish(),
    mitarbeiter: z.string().min(2).nullish(),
    preferred_time: timeSchema.nullish(),
  })
  .transform((value, context) => {
    const services = value.services ??
      (value.service ?? value.leistung ? [value.service ?? value.leistung] : []);
    const date = value.date ?? value.preferred_date;
    if (services.length === 0) {
      context.addIssue({ code: "custom", message: "services is required" });
      return z.NEVER;
    }
    if (!date) {
      context.addIssue({ code: "custom", message: "date is required" });
      return z.NEVER;
    }
    return {
      services: services as string[],
      date,
      staff: value.staff ?? value.mitarbeiter ?? undefined,
      preferredTime: value.preferred_time ?? undefined,
    };
  });

export const bookingArgsSchema = z
  .object({
    services: z.array(z.string().min(2)).min(1).max(4).nullish(),
    service: z.string().min(2).nullish(),
    leistung: z.string().min(2).nullish(),
    start: z.string().min(16),
    staff: z.string().min(2).nullish(),
    mitarbeiter: z.string().min(2).nullish(),
    customer_name: z.string().min(2).nullish(),
    name: z.string().min(2).nullish(),
    phone: z.string().min(5).nullish(),
    telefon: z.string().min(5).nullish(),
  })
  .transform((value, context) => {
    const services = value.services ??
      (value.service ?? value.leistung ? [value.service ?? value.leistung] : []);
    const customerName = value.customer_name ?? value.name;
    const phone = value.phone ?? value.telefon;
    if (services.length === 0 || !customerName || !phone) {
      context.addIssue({
        code: "custom",
        message: "services, customer_name and phone are required",
      });
      return z.NEVER;
    }
    return {
      services: services as string[],
      start: value.start,
      staff: value.staff ?? value.mitarbeiter ?? undefined,
      customerName,
      phone,
    };
  });

export const findAppointmentsArgsSchema = z
  .object({
    phone: z.string().min(5).nullish(),
    telefon: z.string().min(5).nullish(),
    date: dateSchema.nullish(),
    datum: dateSchema.nullish(),
  })
  .transform((value, context) => {
    const phone = value.phone ?? value.telefon;
    if (!phone) {
      context.addIssue({ code: "custom", message: "phone is required" });
      return z.NEVER;
    }
    return {
      phone,
      date: value.date ?? value.datum ?? undefined,
    };
  });

export const cancelAppointmentArgsSchema = z
  .object({
    phone: z.string().min(5).nullish(),
    telefon: z.string().min(5).nullish(),
    appointment_reference: z.string().length(43),
    confirmed: z.boolean(),
  })
  .transform((value, context) => {
    const phone = value.phone ?? value.telefon;
    if (!phone) {
      context.addIssue({ code: "custom", message: "phone is required" });
      return z.NEVER;
    }
    return {
      phone,
      appointmentReference: value.appointment_reference,
      confirmed: value.confirmed,
    };
  });

export const recordingConsentArgsSchema = z.object({
  allowed: z.boolean(),
});
