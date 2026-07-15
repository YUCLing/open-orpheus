export function setFont(font: string | null) {
  document.body.style.fontFamily = font
    ? `${font}, var(--default-font-family)`
    : "";
}
