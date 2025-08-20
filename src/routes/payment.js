// src/routes/payment.js
import express from "express";
// import { requireAuth } from "../middlewares/auth.middleware.js";
import { createRazorpayOrder } from "../controllers/payment.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";
// import { createRazorpayOrder } from "../controllers/payment.controller.js";

const router = express.Router();

router.use(requireAuth); // optional if payment requires authentication

router.post("/create-order", createRazorpayOrder);

export default router;
