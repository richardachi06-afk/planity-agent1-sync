import { parsePhoneNumberFromString } from "libphonenumber-js";

export function normalizeGermanPhone(input: string) {
  const phone = parsePhoneNumberFromString(input, "DE");
  if (!phone?.isValid()) {
    throw new Error("Die Telefonnummer ist ungültig.");
  }
  return phone.number;
}

export function syntheticBookingEmail(e164Phone: string) {
  return `${e164Phone.replace(/\D/g, "")}@georg-hairstudio.de`;
}

export function formatPrice(cents: number | null, fromPrice: boolean) {
  if (cents === null) return null;
  const value = new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
  return fromPrice ? `ab ${value}` : value;
}
