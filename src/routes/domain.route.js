import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { addDomain, verifyDomain } from "../controllers/domain.controller.js";

const router = Router();

// auth required
router.use(requireAuth);

// create/add domain 
router.post("/add-domain", addDomain);

// verify domain with domain id
router.get("/verify-domian/:domainId", verifyDomain);

export default router;