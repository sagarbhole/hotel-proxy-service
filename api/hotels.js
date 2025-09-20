// Hotel Proxy Service - Main File
// This service acts as a middleman between Power BI and Agoda

export default async function handler(req, res) {
  // Enable CORS for Power BI to access this service
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow GET requests for hotel data
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get search parameters from URL
    const { city = '9395', checkin = '2025-11-19', checkout = '2025-11-20', adults = '2', rooms = '1' } = req.query;

    // Validate dates
    if (!isValidDate(checkin) || !isValidDate(checkout)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    // Build the GraphQL query (same one from your network tab)
    const graphqlQuery = `
      query citySearch($CitySearchRequest: CitySearchRequest!, $ContentSummaryRequest: ContentSummaryRequest!, $PricingSummaryRequest: PricingRequestParameters, $PriceStreamMetaLabRequest: PriceStreamMetaLabRequest) {
        citySearch(CitySearchRequest: $CitySearchRequest) {
          properties(ContentSummaryRequest: $ContentSummaryRequest, PricingSummaryRequest: $PricingSummaryRequest, PriceStreamMetaLabRequest: $PriceStreamMetaLabRequest) {
            propertyId
            content {
              informationSummary {
                displayName
                rating
                accommodationType
                address {
                  city { name }
                  area { name }
                }
              }
              reviews {
                cumulative {
                  reviewCount
                  score
                }
              }
            }
            pricing {
              isAvailable
              offers {
                roomOffers {
                  room {
                    pricing {
                      currency
                      price {
                        perNight {
                          exclusive { display }
                          inclusive { display }
                        }
                        perRoomPerNight {
                          exclusive { display }
                          inclusive { display }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    // Build query variables
    const queryVariables = {
      CitySearchRequest: {
        cityId: parseInt(city),
        searchRequest: {
          searchCriteria: {
            isAllowBookOnRequest: true,
            bookingDate: new Date().toISOString(),
            checkInDate: `${checkin}T18:30:00.000Z`,
            localCheckInDate: checkin,
            los: 1,
            rooms: parseInt(rooms),
            adults: parseInt(adults),
            children: 0,
            childAges: [],
            ratePlans: [],
            currency: "INR",
            travellerType: "Couple",
            isUserLoggedIn: false,
            isAPSPeek: false,
            enableOpaqueChannel: false,
            sorting: { sortField: "Ranking", sortOrder: "Desc" },
            requiredBasis: "PRPN",
            requiredPrice: "Exclusive"
          },
          searchContext: {
            locale: "en-us",
            origin: "IN",
            platform: 1,
            deviceTypeId: 1,
            storeFrontId: 3,
            pageTypeId: 103
          }
        }
      },
      ContentSummaryRequest: {
        context: {
          locale: "en-us",
          userOrigin: "IN",
          platform: { id: 1 },
          storeFrontId: 3,
          occupancy: {
            numberOfAdults: parseInt(adults),
            numberOfChildren: 0,
            checkIn: `${checkin}T18:30:00.000Z`
          }
        }
      },
      PricingSummaryRequest: {
        cheapestOnly: true,
        context: {
          clientInfo: {
            languageId: 1,
            origin: "IN",
            platform: 1,
            storefront: 3
          }
        },
        pricing: {
          checkIn: `${checkin}T18:30:00.000Z`,
          checkout: `${checkout}T18:30:00.000Z`,
          localCheckInDate: checkin,
          localCheckoutDate: checkout,
          currency: "INR",
          occupancy: {
            adults: parseInt(adults),
            children: 0,
            childAges: [],
            rooms: parseInt(rooms)
          }
        }
      },
      PriceStreamMetaLabRequest: {
        attributesId: [8, 1, 18, 7, 11, 2, 3]
      }
    };

    // Prepare the request body
    const requestBody = {
      operationName: "citySearch",
      variables: queryVariables,
      query: graphqlQuery
    };

    // Make the request to Agoda with proper headers
    const response = await fetch('https://www.agoda.com/graphql/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Origin': 'https://www.agoda.com',
        'Pragma': 'no-cache',
        'Referer': `https://www.agoda.com/search?city=${city}&checkIn=${checkin}&checkOut=${checkout}&adults=${adults}`,
        'Sec-Ch-Ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'Ag-Language-Locale': 'en-us',
        'Ag-Debug-Override-Origin': 'IN'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`Agoda API responded with status: ${response.status}`);
    }

    const data = await response.json();

    // Check if we got valid data
    if (!data.data || !data.data.citySearch || !data.data.citySearch.properties) {
      return res.status(500).json({ 
        error: 'No hotel data received from Agoda',
        message: 'This might be due to rate limiting or changed API structure'
      });
    }

    // Transform the data into a Power BI-friendly format
    const hotels = data.data.citySearch.properties.map(property => {
      const content = property.content || {};
      const info = content.informationSummary || {};
      const reviews = content.reviews?.cumulative || {};
      const pricing = property.pricing || {};
      const address = info.address || {};

      // Extract price information
      let pricePerNight = null;
      let currency = 'INR';
      
      if (pricing.offers?.roomOffers?.length > 0) {
        const firstRoom = pricing.offers.roomOffers[0]?.room;
        if (firstRoom?.pricing?.price?.perNight?.exclusive?.display) {
          pricePerNight = firstRoom.pricing.price.perNight.exclusive.display;
        }
        if (firstRoom?.pricing?.currency) {
          currency = firstRoom.pricing.currency;
        }
      }

      return {
        PropertyId: property.propertyId?.toString() || '',
        HotelName: info.displayName || 'Unknown Hotel',
        StarRating: info.rating || null,
        AccommodationType: info.accommodationType || null,
        CityName: address.city?.name || '',
        AreaName: address.area?.name || '',
        ReviewCount: reviews.reviewCount || null,
        ReviewScore: reviews.score || null,
        IsAvailable: pricing.isAvailable || false,
        PricePerNight: pricePerNight,
        Currency: currency,
        SearchDate: new Date().toISOString().split('T')[0],
        CheckInDate: checkin,
        CheckOutDate: checkout
      };
    });

    // Return the transformed data
    res.status(200).json({
      success: true,
      count: hotels.length,
      searchParams: { city, checkin, checkout, adults, rooms },
      hotels: hotels
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch hotel data',
      message: error.message,
      suggestion: 'Try again in a few minutes or check if the search parameters are valid'
    });
  }
}

// Helper function to validate date format
function isValidDate(dateString) {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateString)) return false;
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date);
}
