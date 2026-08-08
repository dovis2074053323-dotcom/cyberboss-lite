const { createSupabaseRestClient } = require("./supabase-rest");

// The pet's expression/bubble output — decision 3 (this session): now that
// jiwen/sentinel are retired, nothing else writes `keke_state`. This is
// Cyberboss's own expression output, the "表达出口" half of keke-overflow's
// remaining perception+expression role.
//
// Real columns only (keke-overflow/CLAUDE.md: "keke_state 真实列：expression /
// bubble_text / bubble_style / heat / created_at", confirmed against
// pet.html:722) — deliberately not the `notification_title` field the old
// jiwen/sentinel scripts also sent; that's not a documented real column and
// this is new code, not a port of their payload shape.
function createPetStateClient(config) {
  const client = createSupabaseRestClient({
    baseUrl: config.companionSupabaseUrl,
    anonKey: config.companionSupabaseAnonKey,
  });

  async function pushExpression({ expression, bubbleText, bubbleStyle, heat } = {}) {
    const payload = {};
    if (expression !== undefined) payload.expression = expression;
    if (bubbleText !== undefined) payload.bubble_text = bubbleText;
    if (bubbleStyle !== undefined) payload.bubble_style = bubbleStyle;
    if (heat !== undefined) payload.heat = heat;
    if (Object.keys(payload).length === 0) {
      throw new Error("pet-state: pushExpression requires at least one field");
    }
    await client.patch("keke_state", "id=eq.1", payload);
  }

  return { pushExpression };
}

module.exports = { createPetStateClient };
