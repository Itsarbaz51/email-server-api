import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { addDomain, verifyDomain, getDomains, deleteDomain } from "../controllers/domain.controller.js";
import { verifySubscription } from "../middlewares/subscription.middleware.js";

const router = Router();

router.post("/add-domain", requireAuth, verifySubscription("createDomain"), addDomain);
router.get("/get-domains", requireAuth, getDomains);

router.get("/verify-domain/:domainName", requireAuth, verifySubscription("verifyDomain"), verifyDomain);
router.delete("/delete-domain/:domainName", requireAuth, deleteDomain);


export default router;