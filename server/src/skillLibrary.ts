/**
 * Ready-made skills anyone can add to a Bot with one tap (Bot settings › Skills › Skill library),
 * or a Bot can add for itself with the skill tool. Each is a short, practical playbook.
 */
export interface LibrarySkill { id: string; name: string; category: string; icon: string; description: string; body: string }

const S = (id: string, name: string, category: string, icon: string, description: string, body: string): LibrarySkill => ({ id, name, category, icon, description, body: body.trim() });

export const SKILL_LIBRARY: LibrarySkill[] = [
  // ---------- everyday ----------
  S('daily-briefing', 'Daily briefing', 'Everyday', '☀️', 'A short morning rundown: weather, calendar, news, reminders.', `
When asked for a briefing (or on a morning routine):
1. Check today's calendar (phone tool calendar_events, days 1) and any tasks still open.
2. Get the local weather (web_search "weather <city> today") if the city is known from memory.
3. Pull 3 headlines on topics the user cares about (from memory), one line each with a link.
4. List reminders or follow-ups you know about.
Keep it under 12 lines, friendliest first line, no filler. End with one suggested first action.`),
  S('reminders', 'Reminders and alarms', 'Everyday', '⏰', 'Set alarms, timers and calendar reminders on the phone.', `
1. Turn the request into an exact time (use today's date and the user's timezone).
2. Alarms: phone tool alarm (time HH:MM, label, days if repeating). Timers: phone tool timer (seconds, label).
3. Dated reminders: phone tool calendar_add with a clear title and a 10-minute-before note.
4. Confirm back in one line: what, when, repeating or not.
Never guess AM/PM; ask if unclear.`),
  S('trip-planner', 'Trip planner', 'Everyday', '🧳', 'Plan a trip: route, budget, day-by-day plan, packing list.', `
1. Ask only what is missing: where from/to, dates, budget, who is going, must-dos.
2. Research travel options and 2-3 places to stay (web_search), with prices and links.
3. Make a day-by-day plan (morning / afternoon / evening), realistic travel times.
4. Add a budget table (travel, stay, food, activities, total) and a packing list.
5. Save the plan to the Library (save_file) as trip-<place>.md.`),
  S('recipe-from-fridge', 'Cook with what I have', 'Everyday', '🍳', 'Recipes from the ingredients at hand, with steps and timing.', `
1. List what the user has; ask about allergies or diet once (remember the answer).
2. Suggest 3 dishes that use most of it, each with time and difficulty.
3. For the chosen one: ingredients with amounts, numbered steps, timers to set (offer to set them on the phone).
Keep steps short enough to read while cooking.`),
  S('workout-plan', 'Workout plan', 'Health', '💪', 'A weekly workout plan that fits the user’s goal and equipment.', `
1. Learn goal (strength, fat loss, endurance), days per week, minutes per session, equipment, injuries. Remember them.
2. Build a week: warm-up, main sets (exercise, sets x reps, rest), cool-down.
3. Progression rule for next week. Keep it safe: no maxing out, form cues for each lift.
4. Offer to set reminders for workout days.`),
  S('budget-tracker', 'Budget check-in', 'Money', '💵', 'Track spending against a budget and spot savings.', `
1. Keep the budget categories and limits in memory (ask once).
2. When the user shares spending (text, screenshot or receipt), add it up by category.
3. Show a table: category, spent, limit, left. Flag anything over 80%.
4. Suggest one concrete saving for the biggest category.
Save a running log to the Library as budget-<month>.md.`),

  // ---------- research & writing ----------
  S('web-research', 'Research report', 'Research', '🔎', 'Research a topic from several sources into a clear report with links.', `
1. Restate the question in one line and pick 3-5 search angles.
2. Search (web_search, and x_search for what people are saying now), open the best sources (web_fetch).
3. Compare sources; note where they disagree. Prefer recent and primary sources.
4. Write: summary (5 lines), key findings with links, what is uncertain, recommendation.
5. Save it to the Library as a Markdown file and give the short version in chat.`),
  S('summarize-link', 'Summarize a link or video', 'Research', '📄', 'Summarize an article, page or YouTube video in a few lines.', `
1. Open it (web_fetch). For YouTube, fetch the page and use the transcript/description if available.
2. Give: one-line gist, 3-5 key points, anything to act on, and who it is useful for.
3. Quote numbers exactly; do not invent details that are not in the source.`),
  S('compare-prices', 'Compare and buy smart', 'Money', '🛒', 'Compare products and prices before buying.', `
1. Pin down the need: budget, must-have features, where the user shops.
2. Find 3-5 options (web_search), with current price, rating and a link for each.
3. Table: option, price, key pros, key cons. Pick a winner and a budget pick, and say why.
4. Mention coupons, refurbished options or a better time to buy if relevant.`),
  S('email-writer', 'Write an email', 'Writing', '✉️', 'Draft clear emails in the user’s tone, ready to send.', `
1. Get: who it is to, the goal, any must-say points, and tone (remember the user's usual tone).
2. Write a subject line and a short email: purpose in the first line, details, clear ask, sign-off.
3. Offer a shorter and a more formal version on request. Never send without the user saying so.`),
  S('meeting-notes', 'Meeting notes', 'Writing', '📝', 'Turn a call transcript or rough notes into clean notes and action items.', `
1. From the transcript/notes, write: purpose, decisions, action items (owner, due date), open questions.
2. Keep names and numbers exact. Mark anything unclear with (?).
3. Offer to add action items as tasks or calendar reminders, and to draft the follow-up email.`),

  // ---------- content & business ----------
  S('social-post', 'Social media post', 'Content', '📣', 'Posts for TikTok, Instagram, X, Facebook or YouTube with hooks and CTAs.', `
1. Get the topic, platform, goal (views, followers, sales) and brand voice (remember it).
2. Write 3 hooks (first line / first 2 seconds), then the post or script for the best one.
3. Platform fit: X ≤ 280 chars; Instagram caption + 5-10 hashtags; TikTok/Reels/Shorts as a 20-45s script with on-screen text cues; YouTube with title + description.
4. End with a clear call to action. Offer a posting time and 2 variations to A/B test.`),
  S('video-script', 'Video script', 'Content', '🎬', 'A short-form or YouTube script with hook, beats and B-roll ideas.', `
1. Topic, length, platform, audience.
2. Structure: hook (0-3s), problem, 3 beats with proof or examples, payoff, CTA.
3. Write as a 2-column script: SAY | SHOW (B-roll, text on screen).
4. Add a thumbnail idea and 3 title options.`),
  S('content-calendar', 'Content calendar', 'Content', '🗓️', 'A month of content ideas and a posting schedule.', `
1. Learn the niche, platforms, posting frequency and goals.
2. Mix content pillars (teach, show, story, sell) across the month.
3. Table: date, platform, pillar, idea, hook, CTA. Save it to the Library as a CSV or Markdown file.
4. Offer to draft the first week of posts.`),
  S('business-plan', 'Business plan', 'Business', '📈', 'A lean business plan: customer, offer, pricing, marketing, numbers.', `
1. Ask about the idea, target customer, budget and timeline.
2. Write a one-page lean plan: problem, customer, offer, why us, pricing (3 tiers), channels, costs, first-month goals.
3. Quick competitor scan (web_search): 3 competitors, their prices and gaps.
4. Simple 6-month revenue estimate with clear assumptions. Save to the Library.`),
  S('customer-reply', 'Customer reply', 'Business', '🤝', 'Polite, quick replies to customers, reviews and DMs.', `
1. Read the message; identify what they want and their mood.
2. Reply: thank them, address the point directly, give the next step, keep it under 90 words.
3. For complaints: apologize once, fix or offer a fix, move to a private channel if needed.
Never promise refunds or dates the user has not approved.`),

  // ---------- tech ----------
  S('debug-code', 'Debug code', 'Tech', '🐞', 'Find and fix a bug: reproduce, isolate, fix, verify.', `
1. Get the error message, what was expected, and how to reproduce.
2. Reproduce it (terminal) before changing anything.
3. Narrow it down: read the failing code, add a quick check, test a hypothesis at a time.
4. Fix the root cause, run it again to prove it works, and explain the fix in two lines.
5. Save anything reusable (commands, gotchas) to memory.`),
  S('android-modding', 'Android modding helper', 'Tech', '📱', 'ADB, fastboot, bootloader unlock, custom ROM and root steps, safely.', `
1. Identify the exact model and codename, Android version, and bootloader status. Never assume.
2. Warn about data wipe and warranty before unlocking; check the device's official unlock method.
3. Give commands step by step (adb devices, adb reboot bootloader, fastboot flashing unlock, fastboot flash ...), one at a time, waiting for results.
4. Use only files for the exact codename (ROM, recovery, vbmeta). Keep a backup plan (stock firmware link).
5. After each step, ask for the output before moving on.`),
  S('termux-setup', 'Termux setup', 'Tech', '🐧', 'Install and configure tools in Termux or the built-in Linux.', `
1. Update first: pkg update && pkg upgrade -y (Termux) or apk update (built-in Linux).
2. Install what is needed with the package manager; prefer packages over building from source on the phone.
3. Test each tool once after installing (e.g. node -v, python3 -V).
4. Write a small setup script to the Library so it can be re-run.`),
  S('automate-task', 'Automate a task', 'Tech', '⚙️', 'Turn a repeated chore into a routine or a script.', `
1. Ask how often it happens and what the result should be.
2. If it is a schedule: create_routine with a clear prompt and cron time.
3. If it is a process: write a script (terminal), test it once, save it to the Library.
4. Save the steps as a skill so it can be repeated, and tell the user how to change or stop it.`),

  // ---------- learning ----------
  S('tutor', 'Teach me', 'Learning', '🎓', 'Learn a topic step by step with quizzes.', `
1. Ask what they already know and why they want to learn it.
2. Teach in small steps: one idea, one example, one quick question.
3. Adjust: go back if they miss it, speed up if it is easy. Remember progress in memory.
4. End each session with 3 quiz questions and a one-line summary of what to learn next.`),
  S('journal', 'Daily reflection', 'Health', '🌙', 'A short evening check-in: wins, lessons, tomorrow’s focus.', `
Ask, one at a time: What went well today? What was hard? What did you learn? What is the one thing for tomorrow?
Reflect back in 3 lines, kindly and honestly. Save the entry to the Library as journal/<date>.md.
Notice patterns over weeks and mention them gently.`),
];

export const librarySkill = (idOrName: string) => {
  const k = idOrName.trim().toLowerCase();
  return SKILL_LIBRARY.find((s) => s.id === k || s.name.toLowerCase() === k);
};
