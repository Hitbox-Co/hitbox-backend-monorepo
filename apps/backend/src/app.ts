import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env, isProduction } from '@hitbox/shared';

const app = express();

app.use(cors());
app.use(helmet());

if (isProduction) {
    app.use(morgan("combined"));
} else {
    app.use(morgan("dev"));
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.get("/", (_, res) => {
    res.json({ success: true, message: "HitBox Backend is running 🚀", });
});

export default app;