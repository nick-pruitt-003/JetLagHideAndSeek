import * as React from "react";

const MOBILE_BREAKPOINT = 768;

// Width alone misses a phone turned sideways: an iPhone in landscape is ~844px
// wide, so it got the desktop sidebar pinned open over a third of a ~390px-tall
// screen. A short viewport on a touch screen is a phone whichever way it's held.
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px), (max-height: 500px) and (pointer: coarse)`;

export function useIsMobile() {
    const [isMobile, setIsMobile] = React.useState<boolean | undefined>(
        undefined,
    );

    React.useEffect(() => {
        const mql = window.matchMedia(MOBILE_QUERY);
        const onChange = () => {
            setIsMobile(mql.matches);
        };
        mql.addEventListener("change", onChange);
        // Initial sync — effect runs post-mount so first paint has no
        // measurement; this is the standard responsive-hook pattern.

        setIsMobile(mql.matches);
        return () => mql.removeEventListener("change", onChange);
    }, []);

    return !!isMobile;
}
