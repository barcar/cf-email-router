export default {
  async email(message, env, ctx) {
    const to = String(message.to ?? "").toLowerCase();
    switch (to) {
      case "":
        try {
          const res = fetch("", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `From ${message.from}, subject: ${message.headers.get("subject") ?? "(no subject)"}`,
            }),
          });
          if (!(await res).ok) {
            console.error("Discord webhook failed", (await res).status, (await res).text());
          }
        } catch (e) {
          console.error("Discord webhook error", e);
        }
        await message.forward("");
        break;

      default:
        message.setReject("Unknown address");
    }
  },
};
