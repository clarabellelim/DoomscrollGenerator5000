#!/usr/bin/env python3
import os
import re
import time
import requests
import subprocess
import json
from urllib.parse import quote




# ==================================================
# CONFIG - EDIT THESE VALUES IF NEEDED
# ==================================================
API_KEY = 


HEADLESS = False
AUTO_CLOSE_BROWSER_AFTER_SUBMIT = True
REUSE_BROWSER_FOR_BULK = False
TIMEOUT = 120000


SCRIPT_FOLDER = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(SCRIPT_FOLDER, "analyzed_links_log.txt")


# Valid Instagram username regex (letters, numbers, dots, underscores only)
INSTAGRAM_USERNAME_REGEX = re.compile(r'^[a-zA-Z0-9._]+$')
# ==================================================
# DEPENDENCY CHECK & INSTALL
# ==================================================
def install_dependencies():
    required_packages = ["requests", "playwright"]
    for package in required_packages:
        try:
            __import__(package)
        except ImportError:
            subprocess.check_call([os.sys.executable, "-m", "pip", "install", package])
    subprocess.check_call([os.sys.executable, "-m", "playwright", "install", "chromium"])
install_dependencies()




# ==================================================
# LOG MANAGEMENT
# ==================================================
def init_log_file():
    if not os.path.exists(LOG_FILE):
        with open(LOG_FILE, 'w', encoding='utf-8') as f:
            f.write("")
        print(f"Created duplicate log file: {LOG_FILE}")




def is_duplicate(url):
    normalized_url = url.split('?')[0] if '?' in url else url
    with open(LOG_FILE, 'r', encoding='utf-8') as f:
        for line in f:
            logged_url = line.strip().split('?')[0] if '?' in line.strip() else line.strip()
            if normalized_url == logged_url:
                return True
    return False




def add_to_log(url):
    with open(LOG_FILE, 'a', encoding='utf-8') as f:
        f.write(url + "\n")




# ==================================================
# PLATFORM DETECTION
# ==================================================
def detect_platform(url):
    url_lower = url.lower()
    if 'tiktok.com' in url_lower:
        return 'tiktok'
    elif 'instagram.com' in url_lower and '/reel/' in url_lower:
        return 'instagram'
    elif ('youtube.com' in url_lower and '/shorts/' in url_lower) or 'youtu.be' in url_lower:
        return 'youtube'
    return None




# ==================================================
# ENGAGEMENT EXTRACTION HELPERS
# ==================================================
def extract_tiktok_engagement(pg):
    """
    Extract likes, comments, shares from a TikTok video page.
    Uses multiple strategies: aria-label, data-e2e attributes, strong tags.
    """
    engagement = {"likes": "-", "comments": "-", "shares": "-"}
    try:
        result = pg.evaluate(r'''() => {
            const data = { likes: "-", comments: "-", shares: "-" };


            // Strategy 1: aria-label on action buttons
            // e.g. aria-label="123.4K Likes" / "456 Comments" / "78 Shares"
            document.querySelectorAll('[aria-label]').forEach(el => {
                const label = el.getAttribute('aria-label') || '';
                const lower = label.toLowerCase();
                const match = label.match(/^([\d.,]+[KkMmBb]?)\s/);
                if (match) {
                    if (lower.includes('like'))    data.likes    = match[1];
                    if (lower.includes('comment')) data.comments = match[1];
                    if (lower.includes('share'))   data.shares   = match[1];
                }
            });


            if (data.likes !== "-") return data;


            // Strategy 2: data-e2e attributes TikTok uses internally
            const e2eMap = {
                likes:    ['like-count', 'browse-like-count'],
                comments: ['comment-count', 'browse-comment-count'],
                shares:   ['share-count', 'browse-share-count']
            };
            for (const [key, attrs] of Object.entries(e2eMap)) {
                for (const attr of attrs) {
                    const el = document.querySelector(`[data-e2e="${attr}"]`);
                    if (el && el.textContent.trim()) {
                        data[key] = el.textContent.trim();
                        break;
                    }
                }
            }


            if (data.likes !== "-") return data;


            // Strategy 3: strong tags in the action sidebar (like, comment, share counts)
            const strongs = Array.from(document.querySelectorAll('strong'));
            const counts = strongs
                .map(s => s.textContent.trim())
                .filter(t => /^[\d.,]+[KkMmBb]?$/.test(t));
            if (counts.length >= 1) data.likes    = counts[0];
            if (counts.length >= 2) data.comments = counts[1];
            if (counts.length >= 3) data.shares   = counts[2];


            return data;
        }''')
        engagement = result
        print(f"  TikTok engagement — Likes: {engagement['likes']} | Comments: {engagement['comments']} | Shares: {engagement['shares']}")
    except Exception as e:
        print(f"  TikTok engagement extract failed: {e}")
    return engagement




def extract_instagram_engagement(pg):
    """
    Extract likes and comments from an Instagram Reel page.
    Instagram does not publicly expose share counts so that field will remain '-'.
    """
    engagement = {"likes": "-", "comments": "-", "shares": "-"}
    try:
        result = pg.evaluate(r'''() => {
            const data = { likes: "-", comments: "-", shares: "-" };

            // Strategy 1: og:description meta tag - THIS IS THE MOST RELIABLE SOURCE
            // Format: "249K likes, 308 comments - username on..."
            // We use this FIRST because it's the most accurate
            const desc = document.querySelector('meta[property="og:description"]');
            if (desc) {
                const content = desc.getAttribute('content') || '';
                // Match patterns like "48K likes" or "249,123 likes" or "1.2M likes"
                // Note: We need to match "48K" not just "48"
                const lm = content.match(/([\d,.]+[KkMmBb]?)\s*Likes?/i);
                const cm = content.match(/([\d,.]+[KkMmBb]?)\s*Comments?/i);
                if (lm) data.likes = lm[1];
                if (cm) data.comments = cm[1];
            }

            // If og:description didn't work, try aria-label on buttons
            if (data.likes === "-" || data.comments === "-") {
                document.querySelectorAll('[aria-label]').forEach(el => {
                    const label = el.getAttribute('aria-label') || '';
                    // Match patterns like "249 likes", "1.2K likes"
                    if (data.likes === "-") {
                        const likeMatch = label.match(/^([\d,.]+[KkMmBb]?)\s*like/);
                        if (likeMatch) data.likes = likeMatch[1];
                    }
                    if (data.comments === "-") {
                        const commentMatch = label.match(/^([\d,.]+[KkMmBb]?)\s*comment/);
                        if (commentMatch) data.comments = commentMatch[1];
                    }
                });
            }

            // Last resort: search entire page text but be more specific
            if (data.likes === "-" || data.comments === "-") {
                const allText = document.body.innerText;
                
                // Look for patterns like "X likes" at the start of text (more likely to be the main count)
                if (data.likes === "-") {
                    // Find "likes" that appears after a number with K/M/B suffix
                    const likeMatch = allText.match(/([\d,.]+[KkMmBb]?)\s+like/i);
                    if (likeMatch) data.likes = likeMatch[1];
                }
                
                if (data.comments === "-") {
                    const commentMatch = allText.match(/([\d,.]+[KkMmBb]?)\s+comment/i);
                    if (commentMatch) data.comments = commentMatch[1];
                }
            }

            return data;
        }''')
        engagement = result
        print(f"  Instagram engagement — Likes: {engagement['likes']} | Comments: {engagement['comments']} | Shares: {engagement['shares']}")
    except Exception as e:
        print(f"  Instagram engagement extract failed: {e}")
    return engagement




def extract_youtube_engagement(pg):
    """
    Extract likes and comments from a YouTube Shorts page.
    YouTube does not publicly expose share counts so that field will remain '-'.
    """
    engagement = {"likes": "-", "comments": "-", "shares": "-"}
    try:
        result = pg.evaluate(r'''() => {
            const data = { likes: "-", comments: "-", shares: "-" };

            // Strategy 1: Find the like button and get the displayed count from the span
            // The like count is in a span with class "yt-core-attributed-string" inside the like button
            // Structure: like button -> label -> span with text "63K"
            const likeBtn = document.querySelector('like-button-view-model');
            if (likeBtn) {
                // Try to find the span with the like count inside the like button
                const likeSpans = likeBtn.querySelectorAll('span.yt-core-attributed-string');
                for (const span of likeSpans) {
                    const text = span.textContent.trim();
                    // Check if it looks like a count (e.g., "63K", "1.2M", "123")
                    if (/^[\d,.]+[KkMm]?$/.test(text)) {
                        data.likes = text;
                        break;
                    }
                }
                
                // Also check aria-label on the like button itself for "X thousand" pattern
                if (data.likes === "-") {
                    const label = likeBtn.getAttribute('aria-label') || '';
                    const thousandMatch = label.match(/([\d,.]+)\s*thousand\s*other/i);
                    if (thousandMatch) {
                        data.likes = thousandMatch[1] + 'K';
                    }
                }
            }

            // Strategy 2: Use aria-label patterns for comments - "View X comments"
            // Look for buttons with aria-label containing "View X comments"
            document.querySelectorAll('[aria-label]').forEach(el => {
                const label = el.getAttribute('aria-label') || '';
                // Match "View 196 comments" pattern
                const commentMatch = label.match(/^View ([\d,.]+[KkMm]?)\s*comments?/i);
                if (commentMatch) {
                    data.comments = commentMatch[1];
                }
                
                // Also check for "X thousand other people" pattern (like button)
                if (data.likes === "-") {
                    const likeMatch = label.match(/along with ([\d,.]+)\s*thousand\s*other people/i);
                    if (likeMatch) {
                        data.likes = likeMatch[1] + 'K';
                    }
                }
            });

            // Strategy 3: Parse ytInitialData from page scripts (most reliable for Shorts)
            if (data.likes === "-" || data.comments === "-") {
                try {
                    const scripts = Array.from(document.querySelectorAll('script'));
                    for (const script of scripts) {
                        const text = script.textContent;
                        if (text.includes('ytInitialData') || text.includes('likeCountText')) {
                            // Try to find likeCountText with simpleText
                            if (data.likes === "-") {
                                const likeMatch = text.match(/"likeCountText"[^}]*?"simpleText"\s*:\s*"([^"]+)"/);
                                if (likeMatch) data.likes = likeMatch[1];
                            }
                            if (data.comments === "-") {
                                const commentMatch = text.match(/"commentCountText"[^}]*?"simpleText"\s*:\s*"([^"]+)"/);
                                if (commentMatch) data.comments = commentMatch[1];
                            }
                            if (data.likes !== "-" && data.comments !== "-") break;
                        }
                    }
                } catch(e) {}
            }

            // Strategy 4: Look for "X Comments" text in the page (fallback)
            if (data.comments === "-") {
                const commentElements = document.querySelectorAll('yt-formatted-string, h2, span');
                for (const el of commentElements) {
                    const text = el.textContent.trim();
                    const match = text.match(/^([\d,.]+[KkMm]?)\s*Comments?$/i);
                    if (match) {
                        data.comments = match[1];
                        break;
                    }
                }
            }

            return data;
        }''')
        engagement = result
        print(f"  YouTube engagement — Likes: {engagement['likes']} | Comments: {engagement['comments']} | Shares: {engagement['shares']}")
    except Exception as e:
        print(f"  YouTube engagement extract failed: {e}")
    return engagement




# ==================================================
# VIDEO INFO EXTRACTION
# ==================================================
def get_info(url):
    platform = detect_platform(url)
    print(f"Extracting {platform} data: {url[:50]}...")
    
    # Pre-define clean_url for all platforms
    clean_url = url.split('?')[0] if '?' in url else url
    
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(headless=HEADLESS)
        pg = b.new_page(user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        
        try:
            pg.goto(url, wait_until="domcontentloaded", timeout=TIMEOUT)
            time.sleep(12)
        except:
            b.close()
            fallback_creator = url.split("@")[1].split("/")[0] if "@" in url else "Instagram Creator"
            return {"platform": platform, "url": clean_url, "creator": fallback_creator, "caption": "-", "duration": "-",
                    "likes": "-", "comments": "-", "shares": "-"}
        
        creator = "Instagram Creator"
        caption = "-"
        duration = 0
        engagement = {"likes": "-", "comments": "-", "shares": "-"}




        if platform == "tiktok":
            creator = url.split("@")[1].split("/")[0] if "@" in url else "-"
            try:
                caption = pg.evaluate('''()=>{const m=document.querySelector('meta[property="og:description"]');return m?m.getAttribute('content'):'-'}''')
            except: pass
            try:
                duration = pg.evaluate('''()=>{const v=document.querySelector('video');return v?Math.floor(v.duration):0}''')
            except: pass
            engagement = extract_tiktok_engagement(pg)
        
        elif platform == "instagram":
            try:
                caption = pg.evaluate('''()=>{const m=document.querySelector('meta[property="og:description"]');return m?m.getAttribute('content'):'-'}''')
            except:
                caption = "-"
            
            tagged_users = set()
            if caption != "-":
                tagged_users = set(re.findall(r'@([a-zA-Z0-9._]+)', caption))
                print(f"Found tagged users in caption (will ignore if not in header): {', '.join(tagged_users)}")


            try:
                header_authors = pg.evaluate('''()=>{
                    const allLinks = Array.from(document.querySelectorAll('a'));
                    const usernames = [];
                    
                    allLinks.forEach(link => {
                        const href = link.getAttribute('href') || '';
                        if (href.includes('/reels/audio/') || href.includes('/p/') || href.includes('/reel/')) {
                            return;
                        }
                        const text = link.textContent.trim();
                        if (text && text.length >= 2 && text.length <= 30) {
                            const skipPatterns = ['Instagram', 'More', 'Like', 'Comment', 'Share', 'Save', 
                                                'Verified', 'Follow', 'Following', 'Original audio', 
                                                'View all', 'more', 'and'];
                            if (skipPatterns.includes(text)) return;
                            if (/^[a-zA-Z0-9._]+$/.test(text)) {
                                const parent = link.parentElement;
                                let hasAndNearby = false;
                                if (parent) {
                                    hasAndNearby = parent.textContent.toLowerCase().includes('and');
                                }
                                usernames.push({ username: text, hasAndNearby: hasAndNearby });
                            }
                        }
                    });
                    const collabUsers = usernames.filter(u => u.hasAndNearby).map(u => u.username);
                    const regularUsers = usernames.filter(u => !u.hasAndNearby).map(u => u.username);
                    if (collabUsers.length > 0) return [...new Set(collabUsers)];
                    return regularUsers.slice(0, 3);
                }''')


                valid_authors = []
                invalid_usernames = ["reel", "p", "explore", "tags", "search", "direct", "stories", "accounts", "settings", "privacy"]
                for user in header_authors:
                    user_lower = user.lower()
                    if user_lower not in invalid_usernames and user_lower not in tagged_users and INSTAGRAM_USERNAME_REGEX.match(user):
                        valid_authors.append(f"@{user}")


                if valid_authors:
                    creator = " & ".join(valid_authors)
                    if len(valid_authors) > 1:
                        print(f"✅ PRIORITY 1 MATCH: Found {len(valid_authors)} COLLAB AUTHORS from post header: {creator}")
                    else:
                        print(f"✅ PRIORITY 1 MATCH: Pulled author from post header: {creator}")
            except Exception as e:
                print(f"Header author extract failed: {e}")


            if creator == "Instagram Creator":
                try:
                    json_ld = pg.evaluate('''()=>{
                        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                        for (let s of scripts) {
                            try {
                                const data = JSON.parse(s.textContent);
                                if (data["@type"] === "VideoObject" || data["@type"] === "SocialMediaPosting") {
                                    return data;
                                }
                            } catch(e) {}
                        }
                        return null;
                    }''')
                    if json_ld and "author" in json_ld:
                        authors = []
                        if isinstance(json_ld["author"], list):
                            for author in json_ld["author"]:
                                if "alternateName" in author and author["alternateName"].startswith("@"):
                                    authors.append(author["alternateName"].strip())
                                elif "name" in author:
                                    authors.append(author["name"].strip())
                        else:
                            if "alternateName" in json_ld["author"] and json_ld["author"]["alternateName"].startswith("@"):
                                authors.append(json_ld["author"]["alternateName"].strip())
                            elif "name" in json_ld["author"]:
                                authors.append(json_ld["author"]["name"].strip())
                        if authors:
                            creator = " & ".join(authors)
                            if len(authors) > 1:
                                print(f"✅ PRIORITY 2 FALLBACK: Found {len(authors)} COLLAB AUTHORS from JSON-LD: {creator}")
                            else:
                                print(f"✅ PRIORITY 2 FALLBACK: Pulled author from JSON-LD: {creator}")
                except Exception as e:
                    print(f"JSON-LD extract failed: {e}")


            if creator == "Instagram Creator":
                try:
                    og_title = pg.evaluate('''()=>{
                        const meta = document.querySelector('meta[property="og:title"]');
                        return meta ? meta.getAttribute('content').trim() : '';
                    }''')
                    title_usernames = re.findall(r'@([a-zA-Z0-9._]+)', og_title)
                    if title_usernames:
                        valid_title_authors = [f"@{user}" for user in title_usernames if user and INSTAGRAM_USERNAME_REGEX.match(user)]
                        creator = " & ".join(valid_title_authors)
                        if len(valid_title_authors) > 1:
                            print(f"✅ PRIORITY 3 FALLBACK: Found {len(valid_title_authors)} COLLAB AUTHORS from page title: {creator}")
                        else:
                            print(f"✅ PRIORITY 3 FALLBACK: Pulled author from page title: {creator}")
                except Exception as e:
                    print(f"Page title extract failed: {e}")


            if creator == "Instagram Creator" and 'instagram.com/' in url:
                if '@' in url:
                    candidate = url.split('@')[1].split('/')[0].strip()
                    if candidate and INSTAGRAM_USERNAME_REGEX.match(candidate):
                        creator = f"@{candidate}"
                        print(f"✅ PRIORITY 4 FALLBACK: Pulled author from URL: {creator}")
                else:
                    creator = "Instagram Creator"
                    print(f"⚠️  Could not find specific author, using generic: {creator}")


            try:
                duration = pg.evaluate('''()=>{const v=document.querySelector('video');return v?Math.floor(v.duration):0}''')
            except:
                duration = 0


            engagement = extract_instagram_engagement(pg)
        
        elif platform == "youtube":
            # Clean URL - remove query params for consistent processing
            clean_url = url.split('?')[0] if '?' in url else url
            
            # Wait for the page to fully load the video
            try:
                # Navigate and wait for network to be idle
                pg.goto(url, wait_until="networkidle", timeout=TIMEOUT)
                time.sleep(5)  # Additional wait for video player to initialize
            except:
                try:
                    pg.goto(url, wait_until="domcontentloaded", timeout=TIMEOUT)
                    time.sleep(8)
                except:
                    pass
            
            # Get the current URL (may have changed due to redirect)
            current_url = pg.url
            print(f"  Current URL after load: {current_url[:50]}...")
            
            try:
                # Try to find the creator - check for channel link
                creator = pg.evaluate('''()=>{
                    // Try @channel format
                    const channelLink = document.querySelector('a[href^="/@"]');
                    if (channelLink) return channelLink.textContent.trim();
                    
                    // Try /channel/ format
                    const channelLink2 = document.querySelector('a[href^="/channel/"]');
                    if (channelLink2) return channelLink2.textContent.trim();
                    
                    // Try legacy username format
                    const userLink = document.querySelector('a[href*="/user/"]');
                    if (userLink) return userLink.textContent.trim();
                    
                    return '-';
                }''')
            except: 
                creator = "-"
                
            try:
                caption = pg.evaluate('''()=>{const m=document.querySelector('meta[name="title"]');return m?m.getAttribute('content').trim():'-'}''')
            except: 
                caption = "-"
            
            try:
                duration = pg.evaluate('''()=>{
                    const v = document.querySelector('video');
                    return v ? Math.floor(v.duration) : 0;
                }''')
            except: 
                duration = 0
            
            # If duration is 0, try to wait a bit more and check again
            if duration == 0:
                time.sleep(5)
                try:
                    duration = pg.evaluate('''()=>{
                        const v = document.querySelector('video');
                        return v ? Math.floor(v.duration) : 0;
                    }''')
                except:
                    pass
            
            engagement = extract_youtube_engagement(pg)
        
        b.close()
    
    # For YouTube, use clean URL without query params
    final_url = clean_url if platform == "youtube" else url
    
    return {
        "platform": platform,
        "url": final_url,
        "creator": creator,
        "caption": caption,
        "duration": f"{int(duration//60)}:{int(duration%60):02d}" if duration > 0 else "-",
        "likes":    engagement["likes"],
        "comments": engagement["comments"],
        "shares":   engagement["shares"],
    }




# ==================================================
# AI ANALYSIS PARSING 
# ==================================================
def analyze(info):
    print("Running AI analysis...")
    prompt = f"""You are an expert viral content strategist and cinematographer analyzing a short-form video (TikTok/Instagram Reel/YouTube Short) to understand exactly why it went viral and how to recreate it.




Video Details:
- Platform: {info['platform']}
- Creator: {info['creator']}
- Duration: {info['duration']}
- Caption: {info['caption']}
- Likes: {info.get('likes', '-')}
- Comments: {info.get('comments', '-')}
- Shares: {info.get('shares', '-')}




You MUST output your analysis with EXACTLY THESE HEADERS, wrapped in triple equals signs, no deviations:
===VIRAL===
Analyze WHY this video went viral across these dimensions and why your analysis is accurate and reliable:
- HOOK: What happens in the first 1-3 seconds that stops the scroll? What makes it impossible to swipe away?
- EMOTION: What core emotion does this trigger (curiosity, desire, FOMO, relatability, shock, joy)? How is it sustained throughout?
- PACING & RETENTION: How does the video structure maintain watch time? Where are the re-watch triggers?
- SOCIAL PROOF & TRUST: What signals credibility or authenticity? Why does the audience trust this creator?
- SHAREABILITY: What makes someone want to send this to a friend or repost it? What is the "send this to someone who..." factor?
- TREND ALIGNMENT: What current trends, sounds, formats, or cultural moments does this tap into?
- COMMENT BAIT: What in the video is designed to provoke comments, debate, or responses?




===LENS===
Analyze the cinematographic and visual language of this video that caused the video to go viral and why your analysis is accurate and reliable:
- SHOT COMPOSITION: Describe the framing, rule of thirds usage, negative space, and subject placement
- CAMERA MOVEMENT: Is the camera static, handheld, tracking? What does the movement (or stillness) communicate emotionally?
- LIGHTING: Natural or artificial? Hard or soft light? What mood does the lighting create?
- COLOR GRADING & PALETTE: What colors dominate? What is the overall tone (warm, cool, desaturated, vivid)? What feeling does this evoke?
- EDITING RHYTHM: How fast are the cuts? Are transitions matched to music beats? What editing style is used (jump cuts, montage, single continuous shot)?
- TEXT & GRAPHICS OVERLAY: How is on-screen text used? Font style, placement, timing — what role does it play in the narrative?
- SOUND DESIGN: Is there voiceover, trending audio, original sound, or silence? How does the audio drive the emotional arc?
- CREATOR PRESENCE: How does the creator appear on screen — facing camera, off-camera, POV? What body language and energy do they project?




===AI PROMPT===
Write a single, highly detailed paragraph that a video creator could hand directly to an AI or use as a production brief to recreate this exact video. Include: the opening hook shot, the creator's on-screen presence and energy, the visual aesthetic and color grade, the pacing and editing style, the emotional arc from start to finish, the type of audio or music to use, any text overlays and their timing, and the closing moment or call-to-action. Be specific enough that someone who has never seen the original video could recreate it frame-by-frame."""




    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "Content-Type": "application/json",
                "x-api-key": API_KEY,
                "anthropic-version": "2023-06-01"
            },
            json={
                "model": "claude-sonnet-4-20250514",
                "max_tokens": 3000,
                "messages": [{"role": "user", "content": prompt}]
            },
            timeout=120
        )


        response_json = r.json()
        if "error" in response_json:
            print(f"API error: {response_json['error']}")
            return {"viral": "API error, no analysis available", "lens": "API error, no analysis available", "prompt": "API error, no analysis available"}


        text = response_json.get("content", [{}])[0].get("text", "")
        if not text:
            print("Empty API response")
            return {"viral": "No analysis available", "lens": "No analysis available", "prompt": "No analysis available"}


        print("\n" + "="*40)
        print("RAW AI RESPONSE PREVIEW:")
        print(text[:300] + "..." if len(text) > 300 else text)
        print("="*40 + "\n")


        result = {"viral": "Analysis not available", "lens": "Analysis not available", "prompt": "Analysis not available"}


        viral_match = re.search(
            r'(===VIRAL===|VIRAL:|Reasons It Went Viral:)(.*?)(?====|===LENS===|LENS:|===AI PROMPT===|AI PROMPT:|\Z)',
            text, re.DOTALL | re.IGNORECASE
        )
        lens_match = re.search(
            r'(===LENS===|LENS:|Lens Language Analysis:)(.*?)(?====|===VIRAL===|VIRAL:|===AI PROMPT===|AI PROMPT:|\Z)',
            text, re.DOTALL | re.IGNORECASE
        )
        prompt_match = re.search(
            r'(===AI PROMPT===|AI PROMPT:|Recreation Prompt:)(.*?)(?====|===VIRAL===|VIRAL:|===LENS===|LENS:|\Z)',
            text, re.DOTALL | re.IGNORECASE
        )


        if viral_match:
            result["viral"] = viral_match.group(2).strip()
        if lens_match:
            result["lens"] = lens_match.group(2).strip()
        if prompt_match:
            result["prompt"] = prompt_match.group(2).strip()


        if result["viral"] == "Analysis not available" and len(text) > 100:
            sections = re.split(r'\n\n\s*[A-Z ]+[:=]', text)
            if len(sections) >= 3:
                result["viral"] = sections[0].strip()
                result["lens"] = sections[1].strip()
                result["prompt"] = sections[2].strip()


        print(f"Extracted viral analysis: {result['viral'][:100]}...")
        print(f"Extracted lens analysis: {result['lens'][:100]}...")
        print(f"Extracted AI prompt: {result['prompt'][:100]}...")


        return result


    except requests.exceptions.Timeout:
        print("API request timed out")
        return {"viral": "Request timed out", "lens": "Request timed out", "prompt": "Request timed out"}
    except Exception as e:
        print(f"Analysis error: {e}")
        return {"viral": f"Error: {str(e)}", "lens": f"Error: {str(e)}", "prompt": f"Error: {str(e)}"}




# ==================================================
# FEISHU SUBMISSION
# ==================================================
shared_browser = None
shared_page = None




def init_shared_browser():
    global shared_browser, shared_page
    from playwright.sync_api import sync_playwright
    if not shared_browser:
        p = sync_playwright().start()
        shared_browser = p.chromium.launch(headless=HEADLESS, args=["--start-maximized"])
        shared_page = shared_browser.new_page()
    return shared_page




def close_shared_browser():
    global shared_browser
    if shared_browser:
        shared_browser.close()
        shared_browser = None




def submit(info, analysis, is_bulk=False):
    print(f"\n📤 Submitting individual entry for {info['url'][:50]}...")
    from playwright.sync_api import sync_playwright


    # Field IDs taken directly from the Feishu form HTML
    FIELD_DATA = [
        ("field-item-fldvwMS7YR", str(info.get("url",      "-") or "-")),  # Platform Link
        ("field-item-fldTDQCsde", str(info.get("caption",  "-") or "-")),  # Video Caption
        ("field-item-fldlkTqyvU", str(analysis.get("viral",  "-") or "-")),  # Reasons It Went Viral
        ("field-item-fldFc3dUgL", str(analysis.get("lens",   "-") or "-")),  # Lens Language Analysis
        ("field-item-fld6o8DdAT", str(analysis.get("prompt", "-") or "-")),  # AI Recreation Prompt
        ("field-item-fldbGEe6tI", str(info.get("duration", "-") or "-")),  # Video Duration
        ("field-item-fldijFLXIz", str(info.get("creator",  "-") or "-")),  # Creator Username
        ("field-item-fld23A8brn", str(info.get("likes",    "-") or "-")),  # Number of Likes
        ("field-item-fld568fyaN", str(info.get("comments", "-") or "-")),  # Number of Comments
        ("field-item-fldIRVNuOZ", str(info.get("shares",   "-") or "-")),  # Number of Shares
    ]


    def fill_contenteditable(pg, field_id, value):
        try:
            selector = f"#{field_id} .adit-container:not(.slab-pre-renderer)"
            el = pg.locator(selector).first
            el.scroll_into_view_if_needed(timeout=5000)
            el.click(force=True)
            time.sleep(0.5)


            pg.keyboard.press("Control+a")
            pg.keyboard.press("Backspace")
            time.sleep(0.2)


            el.fill(value, timeout=30000)
            time.sleep(0.5)


            print(f"  OK: {field_id} → {value[:50]}{'...' if len(value) > 50 else ''}")
            return True
        except Exception as e:
            print(f"  FAIL: {field_id} → {e}")
            try:
                selector = f"#{field_id} .adit-container:not(.slab-pre-renderer)"
                el = pg.locator(selector).first
                el.click(force=True)
                time.sleep(0.3)
                pg.keyboard.press("Control+a")
                pg.keyboard.press("Backspace")
                time.sleep(0.2)
                delay = 5 if len(value) > 2000 else 10
                pg.keyboard.type(value, delay=delay)
                time.sleep(0.5)
                print(f"  OK (fallback): {field_id}")
                return True
            except Exception as e2:
                print(f"  FAIL (fallback): {field_id} → {e2}")
                return False


    pg = None
    b = None
    p = None
    if is_bulk and REUSE_BROWSER_FOR_BULK:
        pg = init_shared_browser()
    else:
        p = sync_playwright().start()
        b = p.chromium.launch(headless=HEADLESS, args=["--start-maximized"])
        pg = b.new_page()


    try:
        print("  Loading fresh Feishu form...")
        try:
            pg.goto(FEISHU_URL, wait_until="domcontentloaded", timeout=TIMEOUT)
        except:
            pg.goto(FEISHU_URL, timeout=TIMEOUT)
        time.sleep(10)


        print("  Filling fields...")
        for field_id, value in FIELD_DATA:
            fill_contenteditable(pg, field_id, value)
            time.sleep(0.4)


        pg.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        time.sleep(3)
        btn = pg.locator('button[data-e2e="bitable-form-fill-submit-btn"]')
        btn.click(force=True)
        time.sleep(7)


        print(f"✅ SUBMITTED: New row added for {info['url'][:50]}...")
        add_to_log(info['url'])
        print(f"📝 Logged to file: {info['url'][:50]}...")
        result = True


    except Exception as e:
        print(f"❌ Submission failed: {e}")
        result = False


    finally:
        if not (is_bulk and REUSE_BROWSER_FOR_BULK):
            if b:
                try:
                    b.close()
                except:
                    pass
            if p:
                try:
                    p.stop()
                except:
                    pass
        time.sleep(2)


    return result




# ==================================================
# BULK SCRAPE FUNCTIONS 
# ==================================================
def scrape_tiktok_by_keyword(keyword, limit):
    print(f"\nScraping TikTok for: {keyword}")
    search_url = f"https://www.tiktok.com/search?q={quote(keyword)}&t={int(time.time())}"
    video_links = []


    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(headless=HEADLESS, args=["--window-size=1280,900"])
        pg = b.new_page(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 900}
        )
        try:
            pg.goto(search_url, wait_until="domcontentloaded", timeout=TIMEOUT)
            time.sleep(20)


            SCROLL_STEP = 800
            SCROLL_PAUSE = 2.5
            MAX_SCROLL_ATTEMPTS = 25
            last_count = 0
            stall_count = 0


            for attempt in range(MAX_SCROLL_ATTEMPTS):
                pg.evaluate(f"""()=>{{
                    const selectors = [
                        '[class*="DivSearchResultContainer"]',
                        '[class*="search-result"]',
                        '[class*="SearchResult"]',
                        '[class*="DivContentContainer"]',
                        'main',
                        '#main-content',
                        'body'
                    ];
                    let scrolled = false;
                    for (const sel of selectors) {{
                        const el = document.querySelector(sel);
                        if (el && el.scrollHeight > el.clientHeight) {{
                            el.scrollBy(0, {SCROLL_STEP});
                            scrolled = true;
                            break;
                        }}
                    }}
                    window.scrollBy(0, {SCROLL_STEP});
                }}""")
                time.sleep(SCROLL_PAUSE)


                current_count = pg.evaluate('''()=>{
                    const links = new Set();
                    document.querySelectorAll('a[href*="/video/"]').forEach(a => {
                        if (a.href) links.add(a.href);
                    });
                    return links.size;
                }''')
                print(f"  Scroll {attempt+1}/{MAX_SCROLL_ATTEMPTS}: {current_count} videos found so far...")


                if current_count >= limit:
                    print(f"  Reached target of {limit} videos, stopping scroll.")
                    break


                if current_count == last_count:
                    stall_count += 1
                    if stall_count >= 3:
                        print(f"  No new videos loaded after {stall_count} scrolls, stopping.")
                        break
                else:
                    stall_count = 0
                last_count = current_count


            links = pg.evaluate('''()=>{
                const links = [];
                const seen = new Set();
                document.querySelectorAll('a[href*="/video/"]').forEach(a => {
                    if (a.href && !seen.has(a.href)) {
                        seen.add(a.href);
                        links.push(a.href);
                    }
                });
                return links;
            }''')
            video_links = links[:limit]
            print(f"Found {len(video_links)} TikTok videos")
        except Exception as e:
            print(f"TikTok scrape error: {e}")
        b.close()
    return video_links




def scrape_instagram_by_keyword(keyword, limit):
    print(f"\nScraping Instagram Reels for: {keyword}")
    search_url = f"https://www.instagram.com/explore/tags/{keyword.replace('#', '')}/"
    video_links = []


    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(headless=HEADLESS)
        pg = b.new_page(user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        
        try:
            pg.goto(search_url, wait_until="domcontentloaded", timeout=TIMEOUT)
            time.sleep(5)
            
            # Wait for page to load content
            for i in range(8):
                pg.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                time.sleep(2)
            
            # Extract Reels links - need to get the full href
            links = pg.evaluate(f'''() => {{
                const links = [];
                const seen = new Set();
                
                // Find all anchors that contain /reel/ in href
                document.querySelectorAll('a[href*="/reel/"]').forEach(a => {{
                    let href = a.href;
                    // Extract video ID from URL
                    const match = href.match(/\\/reel\\/([A-Za-z0-9_-]+)/);
                    if (match && !seen.has(match[1])) {{
                        seen.add(match[1]);
                        // Construct clean Reel URL
                        links.push('https://www.instagram.com/reel/' + match[1]);
                    }}
                }});
                
                return links;
            }}''')
            
            # Remove duplicates while preserving order
            seen = set()
            unique_links = []
            for link in links:
                if link not in seen:
                    seen.add(link)
                    unique_links.append(link)
            
            video_links = unique_links[:limit]
            print(f"Found {len(video_links)} Instagram Reels: {video_links[:3]}...")
        except Exception as e:
            print(f"Instagram scrape error: {e}")
            import traceback
            traceback.print_exc()
        b.close()
    return video_links




def scrape_youtube_by_keyword(keyword, limit):
    print(f"\nScraping YouTube Shorts for: {keyword}")
    search_url = f"https://www.youtube.com/results?search_query={quote(keyword)}+shorts&sp=EgIYAQ%253D%253D"
    video_links = []


    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(headless=HEADLESS)
        pg = b.new_page(user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        try:
            pg.goto(search_url, wait_until="domcontentloaded", timeout=TIMEOUT)
            time.sleep(5)
            
            # Wait for page to stabilize and load content
            for i in range(8):
                pg.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                time.sleep(2)
            
            # Extract Shorts links - need to get the full href
            links = pg.evaluate(f'''() => {{
                const links = [];
                const seen = new Set();
                
                // Find all anchors that contain /shorts/ in href
                document.querySelectorAll('a[href*="/shorts/"]').forEach(a => {{
                    let href = a.href;
                    // YouTube sometimes returns relative URLs, need to make them absolute
                    if (href && !href.startsWith('http')) {{
                        href = 'https://www.youtube.com' + href;
                    }}
                    // Extract the video ID from the URL
                    const match = href.match(/\\/shorts\\/([a-zA-Z0-9_-]+)/);
                    if (match && !seen.has(match[1])) {{
                        seen.add(match[1]);
                        // Construct clean Shorts URL
                        links.push('https://www.youtube.com/shorts/' + match[1]);
                    }}
                }});
                
                return links;
            }}''')
            
            # Remove duplicates while preserving order
            seen = set()
            unique_links = []
            for link in links:
                if link not in seen:
                    seen.add(link)
                    unique_links.append(link)
            
            video_links = unique_links[:limit]
            print(f"Found {len(video_links)} YouTube Shorts: {video_links[:3]}...")
        except Exception as e:
            print(f"YouTube scrape error: {e}")
            import traceback
            traceback.print_exc()
        b.close()
    return video_links




# ==================================================
# MAIN WORKFLOW (CLI MODE)
# ==================================================
def main():
    init_log_file()


    print("Choose mode:")
    print("1. Single Link Analysis")
    print("2. Bulk Keyword/Hashtag Analysis")
    mode = input("Enter 1 or 2: ").strip()


    if mode == "1":
        url = input("\nEnter TikTok/Instagram Reel/YouTube Short URL: ").strip()
        platform = detect_platform(url)
        if not platform:
            print("❌ Invalid URL: Must be a public TikTok, Instagram Reel, or YouTube Short link")
            return
        
        if is_duplicate(url):
            print("⚠️  DUPLICATE: This video has already been analyzed")
            return
        
        print("\n--- Extracting Video Info ---")
        info = get_info(url)
        print(f"FINAL EXTRACTED CREATOR(S): {info['creator']}")
        print(f"Duration: {info['duration']}")
        print(f"Likes: {info['likes']} | Comments: {info['comments']} | Shares: {info['shares']}")
        
        print("\n--- Running AI Analysis ---")
        analysis = analyze(info)
        
        print("\n--- Submitting to Feishu ---")
        success = submit(info, analysis)
        if success:
            print("\n✅ DONE! Entry added to Feishu.")
        else:
            print("\n❌ Failed to submit entry.")


    elif mode == "2":
        keyword = input("\nEnter keyword/hashtag (no # needed): ").strip().lstrip('#')
        if not keyword:
            print("❌ Invalid keyword")
            return
        
        new_count = 0
        duplicate_count = 0
        failed_count = 0


        tiktok_links = scrape_tiktok_by_keyword(keyword, BULK_LIMITS['tiktok'])
        ig_links = scrape_instagram_by_keyword(keyword, BULK_LIMITS['instagram'])
        yt_links = scrape_youtube_by_keyword(keyword, BULK_LIMITS['youtube'])
        all_links = tiktok_links + ig_links + yt_links


        print(f"\n{'='*60}")
        print(f"STARTING BULK ANALYSIS: {len(all_links)} TOTAL VIDEOS")
        print('='*60)


        for idx, url in enumerate(all_links, 1):
            print(f"\n--- VIDEO {idx}/{len(all_links)} ---")
            if is_duplicate(url):
                print("⚠️  DUPLICATE: Skipping")
                duplicate_count += 1
                continue
            
            info = get_info(url)
            if not info:
                print("❌ Failed to extract info, skipping")
                failed_count += 1
                continue
            
            print(f"FINAL EXTRACTED CREATOR(S): {info['creator']}")
            print(f"Likes: {info['likes']} | Comments: {info['comments']} | Shares: {info['shares']}")
            analysis = analyze(info)
            success = submit(info, analysis, is_bulk=True)
            if success:
                print(f"✅ Done: {url[:50]}...")
                new_count += 1
            else:
                failed_count += 1
            
            time.sleep(3)


        if REUSE_BROWSER_FOR_BULK:
            close_shared_browser()


        print(f"\n{'='*60}")
        print(f"✅ BULK ANALYSIS COMPLETE")
        print(f"Total videos scraped: {len(all_links)}")
        print(f"New entries added: {new_count}")
        print(f"Duplicates skipped: {duplicate_count}")
        print(f"Failed submissions: {failed_count}")
        print('='*60)


    else:
        print("❌ Invalid mode selection")
        return




if __name__ == "__main__":
    main()
