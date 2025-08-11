import express from "express";
import { requireAuth } from "../middlewares/auth.middleware.js";
import {cancelSubscription, createOrRenewSubscription, getMySubscription} from "../controllers/subscription.controller.js"

const router = express.Router();
router.use(requireAuth)

router.post("/create-subcription", createOrRenewSubscription);
router.get("/get-my-subcription", getMySubscription);
router.delete("/cancel-subcription", cancelSubscription);

export default router;
