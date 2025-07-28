const express = require("express");
const { Pool } = require("pg");
const app = express();
const sendSMS = require("./SMS.js");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
require("dotenv").config();

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "agriconnect drone hub",
  password: "mi vida",
  port: 5432,
});

//  fast-api coonection link
// const 

const calculateDronesAndPrice = (plotSize, droneCoverage, pricePerDrone) => {
  const numberOfDrones = Math.ceil(plotSize / droneCoverage);
  const totalPricePerHour = numberOfDrones * pricePerDrone;
  return { numberOfDrones, totalPricePerHour };
};

const getUserByPhoneNumber = async (phoneNumber) => {
  try {
    const result = await pool.query(
      "SELECT id, name, email FROM users WHERE phone_number = $1",
      [phoneNumber]
    );
    return result.rows.length ? result.rows[0] : null;
  } catch (error) {
    console.error("Database error (getUserByPhoneNumber):", error);
    return null;
  }
};

const getAvailableDrones = async (numberOfDrones) => {
  try {
    const result = await pool.query(
      "SELECT id FROM drones WHERE is_available = TRUE LIMIT $1",
      [numberOfDrones]
    );
    return result.rows.map((row) => row.id);
  } catch (error) {
    console.error("Database error (getAvailableDrones):", error);
    return [];
  }
};

const checkDroneRequestStatus = async (phoneNumber) => {
  try {
    const user = await getUserByPhoneNumber(phoneNumber);
    if (!user) {
      return {
        status: "not_found",
        message: "User not found. Please register first.",
      };
    }
    const result = await pool.query(
      `SELECT p.size_in_acres, p.number_of_drones, pm.amount, pm.status 
       FROM plots p 
       LEFT JOIN payments pm ON pm.buyer_phone = $1 
       WHERE p.user_id = $2 
       ORDER BY p.id DESC LIMIT 1`,
      [phoneNumber, user.id]
    );
    if (result.rows.length) {
      const { size_in_acres, number_of_drones, amount, status } =
        result.rows[0];
      return {
        status,
        message: `Your drone request for ${size_in_acres} acres (${number_of_drones} drones, ${
          amount || 0
        } Tsh) is ${status || "pending"}.`,
      };
    }
    return {
      status: "not_found",
      message: "No drone request found for your phone number.",
    };
  } catch (error) {
    console.error("Database error (checkDroneRequestStatus):", error);
    return { status: "error", message: "Error fetching drone request status." };
  }
};



const userSessions = {};

// New FastAPI route
app.post("/ussd-fastapi", async (req, res) => {
  const { sessionId, serviceCode, phoneNumber, text } = req.body;

  let response = "";

  // Initialize session if not already set
  if (!userSessions[sessionId]) {
    userSessions[sessionId] = { state: "fastapi_menu" };
  }

  const session = userSessions[sessionId];
  const input = text ? text.split("*").pop() : "";

  console.log(`FastAPI Route - Session ID: ${sessionId}, State: ${session.state}, Input: ${text}, Latest Input: ${input}`);

  try {
    // Call FastAPI endpoint
    const fastApiResponse = await axios.post("http://localhost:8000/api/ussd-process", {
      phoneNumber,
      text,
      sessionId,
    });

    const { message, status } = fastApiResponse.data;

    // Ensure response is USSD-compatible
    if (status === "CON" || status === "END") {
      response = `${status} ${message}`;
    } else {
      response = `END Invalid response from server.`;
    }

    // Clear session if END
    if (status === "END") {
      delete userSessions[sessionId];
    }
  } catch (error) {
    console.error("FastAPI error:", error.message);
    response = `END Error connecting to service. Please try again later.`;
    delete userSessions[sessionId];
  }

  res.set("Content-Type: text/plain");
  res.send(response);
});


app.post("/ussd", async (req, res) => {
  const { sessionId, serviceCode, phoneNumber, text } = req.body;

  let response = "";

  // Initialize session if not already set
  if (!userSessions[sessionId]) {
    userSessions[sessionId] = { state: "main_menu" };
  }

  const session = userSessions[sessionId];
  const input = text ? text.split("*").pop() : "";

  console.log(
    `Session ID: ${sessionId}, State: ${session.state}, Input: ${text}, Latest Input: ${input}`
  );

  if (session.state === "main_menu" && text === "") {
    response = `CON Welcome to AgriConnect Drone Hub. Choose an option:
        1. Request Drone
        2. Check Drone Status
        3. Report Issue
        4. Feedback & Rating
        5. Refer Farmer`;
  } else if (session.state === "main_menu") {
    const user = await getUserByPhoneNumber(phoneNumber);
    if (!user && input !== "1") {
      response = `END User not found. Please register or request a drone to continue.`;
      delete userSessions[sessionId];
    } else {
      if (input === "1") {
        session.state = "select_acre_range";
        response = `CON Select your plot size in acres:
          1. 1 - 5 acres
          2. 6 - 10 acres
          3. 11 - 15 acres
          4. 16 - 20 acres
          5. 21+ acres`;
      } else if (input === "2") {
        const droneStatus = await checkDroneRequestStatus(phoneNumber);
        response = `END ${droneStatus.message}`;
        delete userSessions[sessionId];
      } else if (input === "3") {
        session.state = "report_issue";
        session.userId = user.id;
        response = `CON Please describe the issue (e.g., drone malfunction, delay):`;
      } else if (input === "4") {
        session.state = "feedback_rating";
        session.userId = user.id;
        response = `CON Rate our service (1-5, where 5 is excellent):`;
      } else if (input === "5") {
        session.state = "refer_farmer";
        session.userId = user.id;
        response = `CON Enter the phone number of the farmer you want to refer:`;
      } else {
        response = `CON Invalid option. Please select:
          1. Request Drone
          2. Check Drone Status
          3. Report Issue
          4. Feedback & Rating
          5. Refer Farmer`;
      }
    }
  } else if (session.state === "select_acre_range") {
    let plotSize = 0;
    if (input === "1") plotSize = 5;
    else if (input === "2") plotSize = 10;
    else if (input === "3") plotSize = 15;
    else if (input === "4") plotSize = 20;
    else if (input === "5") plotSize = 25;
    else {
      response = `CON Invalid option. Please select:
        1. 1 - 5 acres
        2. 6 - 10 acres
        3. 11 - 15 acres
        4. 16 - 20 acres
        5. 21+ acres`;
      res.set("Content-Type: text/plain");
      res.send(response);
      return;
    }

    session.plotSize = plotSize;
    const droneCoverage = 2;
    const pricePerDrone = 15000;
    const { numberOfDrones, totalPricePerHour } = calculateDronesAndPrice(
      plotSize,
      droneCoverage,
      pricePerDrone
    );

    session.numberOfDrones = numberOfDrones;
    session.totalPricePerHour = totalPricePerHour;

    const droneIds = await getAvailableDrones(numberOfDrones);
    if (droneIds.length < numberOfDrones) {
      response = `END Not enough drones available (${droneIds.length}/${numberOfDrones} available). Please try again later.`;
      delete userSessions[sessionId];
    } else {
      session.droneIds = droneIds;
      session.state = "confirm_details";
      response = `CON For a plot size of ${plotSize} acres:
        - Number of drones assigned: ${numberOfDrones}
        - Total price per hour: ${totalPricePerHour} Tsh
        Are you ready to proceed?
        1. Yes
        2. Cancel`;
    }
  } else if (session.state === "confirm_details") {
    if (input === "1") {
      session.state = "enter_pin";
      response = `CON Enter your PIN to confirm payment.`;
    } else if (input === "2") {
      response = `END Request canceled. Thank you for using AgriConnect Drone Hub.`;
      delete userSessions[sessionId];
    } else {
      response = `CON Invalid option. Please select:
        1. Yes
        2. Cancel`;
    }
  } else if (session.state === "enter_pin") {
    const enteredPin = input;
    const validPin = "1234"; // Replace with database-driven PIN in production

    if (enteredPin === validPin) {
      try {
        const user = await getUserByPhoneNumber(phoneNumber);
        const orderId = uuidv4();
        await pool.query("BEGIN"); // Start transaction
        // Insert plot
        const plotResult = await pool.query(
          "INSERT INTO plots (size_in_acres, number_of_drones, user_id) VALUES ($1, $2, $3) RETURNING id",
          [session.plotSize, session.numberOfDrones, user?.id || null]
        );
        const plotId = plotResult.rows[0].id;
        // Insert plot_drones mappings
        for (const droneId of session.droneIds) {
          await pool.query(
            "INSERT INTO plot_drones (plot_id, drone_id) VALUES ($1, $2)",
            [plotId, droneId]
          );
          await pool.query(
            "UPDATE drones SET is_available = FALSE WHERE id = $1",
            [droneId]
          );
        }
        // Insert payment
        await pool.query(
          "INSERT INTO payments (order_id, amount, buyer_name, buyer_email, buyer_phone, extra_data, status, paid) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [
            orderId,
            session.totalPricePerHour,
            user?.name || "Unknown",
            user?.email || null,
            phoneNumber,
            JSON.stringify({
              plotSize: session.plotSize,
              numberOfDrones: session.numberOfDrones,
              droneIds: session.droneIds,
            }),
            "completed",
            true,
          ]
        );
        await pool.query("COMMIT"); // Commit transaction
        response = `END Payment Successful! ${session.numberOfDrones} drones have been assigned to your ${session.plotSize}-acre plot.`;
        sendSMS(
          phoneNumber,
          `Your payment was successful. ${session.numberOfDrones} drones have been assigned to your ${session.plotSize}-acre plot. Thank you for using AgriConnect Drone Hub!`
        );
        delete userSessions[sessionId];
      } catch (error) {
        await pool.query("ROLLBACK");
        console.error("Database error (insert plot/payment):", error);
        response = `END Error processing your request. Please try again later.`;
        delete userSessions[sessionId];
      }
    } else {
      session.retryCount = (session.retryCount || 0) + 1;
      if (session.retryCount < 3) {
        response = `CON Invalid PIN. Please try again (${
          3 - session.retryCount
        } attempts left).`;
      } else {
        response = `END Too many invalid PIN attempts. Please start over.`;
        delete userSessions[sessionId];
      }
    }
  } else if (session.state === "report_issue") {
    if (input.trim() === "") {
      response = `CON Issue description cannot be empty. Please describe the issue:`;
    } else {
      try {
        await pool.query(
          "INSERT INTO issues (user_id, issue_description, status) VALUES ($1, $2, $3)",
          [session.userId, input, "submitted"]
        );
        response = `END Issue reported successfully. Our team will review it soon.`;
        sendSMS(
          phoneNumber,
          `Your issue has been reported: "${input}". Our team will review it soon. Thank you for using AgriConnect Drone Hub!`
        );
        delete userSessions[sessionId];
      } catch (error) {
        console.error("Database error (report issue):", error);
        response = `END Error reporting issue. Please try again later.`;
        delete userSessions[sessionId];
      }
    }
  } else if (session.state === "feedback_rating") {
    const rating = parseInt(input);
    if (isNaN(rating) || rating < 1 || rating > 5) {
      response = `CON Invalid rating. Please enter a number between 1 and 5:`;
    } else {
      session.rating = rating;
      session.state = "feedback_comments";
      response = `CON Thank you for rating us ${rating}/5. Please provide any comments (or enter 0 to skip):`;
    }
  } else if (session.state === "feedback_comments") {
    const comments = input === "0" ? null : input;
    try {
      await pool.query(
        "INSERT INTO feedback (user_id, rating, comments) VALUES ($1, $2, $3)",
        [session.userId, session.rating, comments]
      );
      response = `END Thank you for your feedback!`;
      sendSMS(
        phoneNumber,
        `Thank you for your ${session.rating}/5 rating${
          comments ? ` and comments: "${comments}"` : ""
        }. We value your feedback!`
      );
      delete userSessions[sessionId];
    } catch (error) {
      console.error("Database error (submit feedback):", error);
      response = `END Error submitting feedback. Please try again later.`;
      delete userSessions[sessionId];
    }
  } else if (session.state === "refer_farmer") {
    const referredPhoneNumber = input;
    if (!/^\+?\d{10,15}$/.test(referredPhoneNumber)) {
      response = `CON Invalid phone number. Please enter a valid phone number (e.g., +255123456789):`;
    } else {
      try {
        await pool.query(
          "INSERT INTO referrals (referrer_user_id, referred_phone_number, status) VALUES ($1, $2, $3)",
          [session.userId, referredPhoneNumber, "pending"]
        );
        response = `END Referral submitted successfully!`;
        sendSMS(
          referredPhoneNumber,
          `You have been referred to AgriConnect Drone Hub by ${phoneNumber}. Dial *149*46*20# to explore our drone services!`
        );
        sendSMS(
          phoneNumber,
          `Your referral of ${referredPhoneNumber} was successful. Thank you for using AgriConnect Drone Hub!`
        );
        delete userSessions[sessionId];
      } catch (error) {
        console.error("Database error (submit referral):", error);
        response = `END Error submitting referral. Please try again later.`;
        delete userSessions[sessionId];
      }
    }
  } else {
    response = `END Invalid input. Please try again.`;
    delete userSessions[sessionId];
  }

  res.set("Content-Type: text/plain");
  res.send(response);
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`USSD Server running on http://localhost:${PORT}`);
});
