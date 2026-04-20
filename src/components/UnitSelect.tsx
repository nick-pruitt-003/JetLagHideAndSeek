import { Select } from "@/components/ui/select";
import type { Units } from "@/maps/schema";

export const UnitSelect = ({
    unit,
    onChange,
    disabled,
}: {
    unit: Units;
    onChange: (unit: Units) => void;
    disabled?: boolean;
}) => {
    return (
        <Select
            trigger="Unit"
            options={{
                miles: "Miles",
                kilometers: "Kilometers",
                meters: "Meters",
            }}
            disabled={disabled}
            value={unit}
            onValueChange={onChange}
        />
    );
};
