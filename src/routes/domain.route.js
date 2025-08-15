import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { addDomain, verifyDomain, getDomains } from "../controllers/domain.controller.js";
import { verifySubscription } from "../middlewares/subscription.middleware.js";

const router = Router();

// auth required
// router.use(requireAuth);

// create/add domain 
router.post("/add-domain",requireAuth, verifySubscription("createDomain"), addDomain);
router.get("/get-domains",requireAuth,  getDomains);

// verify domain with domain id
router.get("/verify-domian/:domainName", verifyDomain);

export default router;