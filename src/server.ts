import app from "./app";
import { ENV, assertProductionConfig } from "./config/env";

assertProductionConfig();

app.listen(ENV.PORT, () => {
    console.log(`Server running on http://localhost:${ENV.PORT}`);
});
