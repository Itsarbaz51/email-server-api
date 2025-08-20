// src/controllers/payment.controller.js
import Razorpay from "razorpay";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

export const createRazorpayOrder = async (req, res) => {
  const { amount, currency, plan, billingCycle } = req.body;

  if (!amount || !currency) {
    return res
      .status(400)
      .json({ success: false, message: "Amount and currency required" });
  }

  try {
    const options = {
      amount, // in paise
      currency,
      receipt: `receipt_${Date.now()}`,
      payment_capture: 1,
    };

    const order = await razorpay.orders.create(options);

    res.status(200).json(order);
  } catch (error) {
    console.error("Razorpay order creation error:", error);
    res.status(500).json({ success: false, message: "Unable to create order" });
  }
};
