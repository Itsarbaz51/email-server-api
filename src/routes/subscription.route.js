import express from "express";
import { requireAuth } from "../middlewares/auth.middleware.js";
import {cancelSubscription, createSubscription, getMySubscription, updateSubscription} from "../controllers/subscription.controller.js"

const router = express.Router();
router.use(requireAuth)

router.post("/create-subcription", createSubscription);
router.get("/get-my-subcription", getMySubscription);
router.put("/renew-subcription", updateSubscription);
router.delete("/cancel-subcription", cancelSubscription);

export default router;
