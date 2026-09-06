/**
 * WCAG 2.1 relative-luminance and contrast-ratio maths.
 *
 * Used to assert the map palette in tests rather than eyeballing screenshots.
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */

export type Rgb = [number, number, number];

const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

/** Parse `#rgb` or `#rrggbb`. Named CSS colours are not supported. */
export const parseHex = (hex: string): Rgb => {
    let h = hex.replace("#", "").trim();
    if (h.length === 3) {
        h = h
            .split("")
            .map((c) => c + c)
            .join("");
    }
    if (!/^[0-9a-f]{6}$/i.test(h)) {
        throw new Error(`Not a hex colour: ${hex}`);
    }
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
};

export const relativeLuminance = ([r, g, b]: Rgb): number =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** Composite a translucent colour over an opaque one. */
export const flatten = (fg: string, alpha: number, bg: string): Rgb => {
    const f = parseHex(fg);
    const b = parseHex(bg);
    return f.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha))) as Rgb;
};

/** WCAG contrast ratio, 1:1 (identical) to 21:1 (black on white). */
export const contrastRatio = (a: Rgb | string, b: Rgb | string): number => {
    const l1 = relativeLuminance(typeof a === "string" ? parseHex(a) : a);
    const l2 = relativeLuminance(typeof b === "string" ? parseHex(b) : b);
    const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
};

/** WCAG 2.1 AA minimums. */
export const AA_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;
export const AA_NON_TEXT = 3;
