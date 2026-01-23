// Mock Configuration
const CONFIG = {
    url: 'https://example.invalid/modeling-requests'
};

// The user-provided JSON (Mocking the stars with likely numbers for parsing demo)
// "3***.31***5" -> likely 30.31 for price.
const item = {
    "id": "35334", // 35***34
    "type": "modelingRequest",
    "attributes": {
        "uid": "1123456",
        "title": "Panel trolley without bars - eurokraft pro / platform 1600 x 800 mm ",
        "status": "created",
        "statusLabel": { "text": "Ready to start", "color": "" },
        "compensation": "18.5",
        "tags": ["low-poly"],
        "groupType": "variations",
        "groupData": {
            "compensation": "74.00",
            "size": 4,
            "complexity": 8,
            "pricingInformation": {
                "price": 30.31,
                "priceBoostUsed": true,
                "originalPrice": 24.5,
                "multiplier": 1.25,
                "multiplierBonus": 5.0
            }
        },
        "partOfGroupOfRequests": true,
        "dynamicDeadline": false,
        "internalTags": ["parent", "sow51_prio3"],
        "unreadEventsCount": 1,
        "pricingInformation": {
            "price": 30.31, // Matching the ***3.1***5 pattern
            "priceBoostUsed": true,
            "originalPrice": 18.5,
            "multiplier": 1.5,
            "multiplierBonus": 2.2
        },
        "complexity": 4,
        "hasDesignerOffer": false,
        "pipeline": "low_poly",
        "lastRound": null,
        "hoursTillDeadline": 130,
        "nextRoundDeadline": "2026-01..."
    }
};

// EXACT LOGIC FROM index.js
const parseJob = (item) => {
    const attr = item.attributes || {};
    const isGrouped = attr.partOfGroupOfRequests === true;

    // Logic from index.js
    const jobUrl = `${CONFIG.url}/${item.id}/brief`;
    const groupedPrice = attr.groupData?.pricingInformation?.price;
    const itemPrice = attr.pricingInformation?.price;
    const priceCandidate = (isGrouped ? (groupedPrice ?? itemPrice) : itemPrice);
    const price = priceCandidate ?? parseFloat(attr.compensation) ?? 0;

    return {
        id: item.id,
        url: jobUrl,
        price: price,
        isGrouped: isGrouped,
        variations: isGrouped ? (attr.groupData?.size || 1) : 1,
        pricePerUnit: isGrouped ? (price / (attr.groupData?.size || 1)) : price
    };
}

const result = parseJob(item);
console.log("--- BOT PARSING RESULT ---");
console.log("URL:", result.url);
console.log("Price:", result.price);
console.log("Is Grouped:", result.isGrouped);
console.log("Ref Name:", result.title); // Demonstrate if this exists or not
console.log("Complete Object:", JSON.stringify(result, null, 2));

console.log("\n--- ANSWERING USER QUESTIONS ---");
console.log("1. URL to go to:", result.url);
console.log("2. Price:", result.price);
console.log("3. Job Name:", result.title || "UNDEFINED (Bot does not extract title)");
console.log("4. Grouped/Solo:", result.isGrouped ? "Grouped" : "Solo");
