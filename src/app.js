import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

const app = express();
const data = "50mb";

app.use(
  cors({
    origin: (origin, callback) => {
      const allowed = ["https://email.primewebdev.in", "http://localhost:5173"];
      if (!origin || allowed.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

app.use(express.json({ limit: data }));
app.use(express.urlencoded({ extended: true, limit: data }));
app.use(cookieParser());

import authRoutes from "./routes/auth.route.js";
import domainRoutes from "./routes/domain.route.js";
import mailboxRoute from "./routes/mailbox.route.js";
import mailRoute from "./routes/mail.route.js";
import subscriptionRoute from "./routes/subscription.route.js";
import dashboardRoute from "./routes/dashboard.route.js";

app.use("/api/auth", authRoutes);
app.use("/api/domain", domainRoutes);
app.use("/api/mailboxes", mailboxRoute);
app.use("/api/mail", mailRoute);
app.use("/api/subscription", subscriptionRoute);
app.use("/api/dashboard", dashboardRoute);

app.get("/", (req, res) => {
  res.send("Hello from root!");
});

export default app;
