import { env } from "@hitbox/shared";

import app from "./app";

app.listen(env.PORT, () => {
    console.log(`🚀 Server running on http://localhost:${env.PORT}`);
});