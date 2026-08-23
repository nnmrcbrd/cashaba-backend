export const detectCategory = (description: string): string => {
    const text = description.toLowerCase();

    if (
        text.includes("food") ||
        text.includes("restaurant") ||
        text.includes("jollibee") ||
        text.includes("mcdo") ||
        text.includes("mcdonald")
    ) {
        return "Food & Dining";
    }

    if (
        text.includes("electric") ||
        text.includes("water") ||
        text.includes("internet") ||
        text.includes("bill")
    ) {
        return "Utilities";
    }

    if (
        text.includes("grab") ||
        text.includes("angkas") ||
        text.includes("joyride") ||
        text.includes("transport")
    ) {
        return "Transport";
    }

    if (
        text.includes("shop") ||
        text.includes("shopping") ||
        text.includes("lazada") ||
        text.includes("shopee")
    ) {
        return "Shopping";
    }

    if (
        text.includes("salary") ||
        text.includes("payroll") ||
        text.includes("income")
    ) {
        return "Salary";
    }

    return "Others";
};
